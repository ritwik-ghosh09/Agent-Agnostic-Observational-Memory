#!/usr/bin/env node

/**
 * Live Query Monitor — preview Memory context for a *typed-but-unsent* CLI prompt.
 *
 * Runs alongside a coding-agent tmux session (Copilot CLI, Claude Code, or
 * OpenCode) — either on the host, or inside the `coding-services` container
 * reaching the host tmux server through a bind-mounted socket (LQM_TMUX_SOCKET).
 * It periodically snapshots the agent's tmux pane with
 * `tmux capture-pane -p`, extracts the draft the user is currently typing (via
 * InputDraftExtractor), and emits three kinds of update to the Health Dashboard
 * so the "Live Context" tab can render three zones:
 *
 *   1. Draft stream — on every change, POST the in-progress draft to
 *      `/api/live-context/draft` → streamed live into the main heading bar.
 *   2. Context — once the draft is *stable* for LQM_STABLE_MS (default 3 s),
 *      POST it to `/api/live-context/query`; the dashboard runs the Knowledge
 *      Context Injection memory pipeline and broadcasts Working + Observational
 *      memory for the live query → the two memory columns.
 *   3. Submitted — when the draft transitions non-empty → empty (the user pressed
 *      Enter and the input box cleared), POST the just-sent query to
 *      `/api/live-context/submitted` → appended to the "Recent Queries" log.
 *
 * Why not a UserPromptSubmit hook? The prompt has not been submitted yet — it
 * only exists on screen — so the terminal snapshot is the single source of truth.
 *
 * Environment variables:
 *   LQM_SESSION          tmux session/target to capture. Optional: when unset the
 *                        monitor auto-detects the most-recently-active `coding-*`
 *                        session and re-scans whenever that session disappears,
 *                        so it always tracks the current CLI without a relaunch.
 *   LQM_TMUX_SOCKET      explicit tmux server socket path (overrides discovery).
 *   LQM_TMUX_SOCKET_DIR  directory holding the host tmux socket(s) (tmux-<uid>/…).
 *                        Set when running inside the container — the socket lives
 *                        under the bind-mounted .data dir because Docker Desktop
 *                        does not share /tmp. The monitor discovers and re-resolves
 *                        the live socket automatically. Unset → default socket.
 *   LQM_AGENT            agent name: copilot | claude | opencode (default: inferred
 *                        from the session name `coding-<agent>-<pid>`, else agent)
 *   LQM_DASHBOARD_PORT   dashboard API port (default: API_PORT from .env.ports or 3033)
 *   LQM_POLL_MS          poll interval ms (default 350)
 *   LQM_STABLE_MS        draft must be unchanged this long before retrieve (default 3000)
 *   LQM_MIN_INTERVAL_MS  minimum gap between retrievals (default 1200)
 *   LQM_BUDGET           retrieval token budget (default 1000)
 *   CODING_REPO          coding repo root (for .env.ports lookup)
 *   CODING_PROJECT_DIR   project dir for retrieval context (default: cwd)
 *   SESSION_ID           agent session id (for correlation)
 *
 * Fail-open: every error path is swallowed; the monitor never disrupts the CLI.
 * Zero npm dependencies — node built-ins only.
 *
 * @module live-query-monitor
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { extractDraft, getProfile } from '../src/live-logging/InputDraftExtractor.js';
import { isSubstantivePrompt } from '../src/hooks/query-builder.js';

let SESSION = process.env.LQM_SESSION || null;
let AGENT = (process.env.LQM_AGENT || 'agent').toLowerCase();
const AUTODETECT = !SESSION;
const TMUX_SOCKET_DIR = process.env.LQM_TMUX_SOCKET_DIR || '';
let TMUX_SOCKET = process.env.LQM_TMUX_SOCKET || '';
const SESSION_PREFIX = process.env.LQM_SESSION_PREFIX || 'coding-';
const CODING_REPO = process.env.CODING_REPO || process.cwd();
const PROJECT_DIR = process.env.CODING_PROJECT_DIR || process.env.TARGET_PROJECT_DIR || process.cwd();
const PROJECT = basename(PROJECT_DIR);
let SESSION_ID = process.env.SESSION_ID || `${AGENT}-${process.pid}`;

const POLL_MS = intEnv('LQM_POLL_MS', 350);
const STABLE_MS = intEnv('LQM_STABLE_MS', 3000);
const MIN_INTERVAL_MS = intEnv('LQM_MIN_INTERVAL_MS', 1200);
const BUDGET = intEnv('LQM_BUDGET', 1000);

const DASHBOARD_PORT = resolveDashboardPort();

/**
 * Build the input-draft extraction profile for an agent. `LQM_INPUT_MARKERS`
 * (comma-separated) optionally overrides the prompt markers so operators can tune
 * a CLI whose chrome changed without editing code.
 *
 * @param {string} agent  agent name (copilot | claude | opencode | …)
 * @returns {object} extraction profile
 */
function buildProfile(agent) {
  const base = getProfile(agent);
  const override = process.env.LQM_INPUT_MARKERS;
  if (override) {
    const markers = override.split(',').map((s) => s.trim()).filter(Boolean);
    if (markers.length) return { ...base, promptMarkers: markers };
  }
  return base;
}

let PROFILE = buildProfile(AGENT);

/** Parse an integer env var with a fallback. */
function intEnv(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Resolve the dashboard API port: explicit override → .env.ports API_PORT → 3033.
 */
function resolveDashboardPort() {
  if (process.env.LQM_DASHBOARD_PORT) {
    const p = parseInt(process.env.LQM_DASHBOARD_PORT, 10);
    if (Number.isFinite(p)) return p;
  }
  try {
    const txt = readFileSync(join(CODING_REPO, '.env.ports'), 'utf8');
    const m = txt.match(/^\s*SYSTEM_HEALTH_API_PORT\s*=\s*(\d+)/m);
    if (m) return parseInt(m[1], 10);
  } catch { /* ignore — fall through to default */ }
  return 3033;
}

// ---- State ------------------------------------------------------------------
let lastDraft = null;        // most recent extracted draft
let lastDraftAt = 0;         // when lastDraft was first observed (stability timer)
let lastSentQuery = null;    // last query we actually retrieved on
let lastSentAt = 0;          // when we last fired a retrieval
let lastNonEmptyDraft = null; // last non-empty draft seen (for submission detection)
let stopped = false;

/**
 * Prefix tmux argv with `-S <socket>` when a host socket is resolved, so the
 * monitor can target the host's tmux server from inside the container. Returns
 * the argv unchanged when no explicit socket is configured (default discovery).
 *
 * @param {string[]} args  tmux subcommand + flags
 * @returns {string[]} argv for execFileSync('tmux', …)
 */
function tmuxArgs(args) {
  return TMUX_SOCKET ? ['-S', TMUX_SOCKET, ...args] : args;
}

/**
 * Discover a tmux server socket under LQM_TMUX_SOCKET_DIR. tmux stores its
 * sockets as `<dir>/tmux-<uid>/<name>`; the container reaches the host server
 * through the bind-mounted .data dir (Docker Desktop won't share /tmp). Returns
 * the most-recently-touched socket file, or '' when none exists yet.
 *
 * @returns {string}
 */
function discoverSocket() {
  if (!TMUX_SOCKET_DIR) return '';
  try {
    const candidates = [];
    for (const entry of readdirSync(TMUX_SOCKET_DIR)) {
      if (!entry.startsWith('tmux-')) continue;
      const sub = join(TMUX_SOCKET_DIR, entry);
      let dirStat;
      try { dirStat = statSync(sub); } catch { continue; }
      if (!dirStat.isDirectory()) continue;
      for (const f of readdirSync(sub)) {
        const p = join(sub, f);
        try {
          const fst = statSync(p);
          if (fst.isSocket()) candidates.push({ path: p, mtime: fst.mtimeMs });
        } catch { /* skip unreadable entry */ }
      }
    }
    if (!candidates.length) return '';
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].path;
  } catch {
    return '';
  }
}

/**
 * Ensure TMUX_SOCKET points at a live socket. An explicit LQM_TMUX_SOCKET pins
 * the path; otherwise we (re-)discover under LQM_TMUX_SOCKET_DIR, dropping a
 * cached socket that has vanished (tmux server restarted with a new path).
 */
function ensureSocket() {
  if (process.env.LQM_TMUX_SOCKET) {
    TMUX_SOCKET = process.env.LQM_TMUX_SOCKET;
    return;
  }
  if (!TMUX_SOCKET_DIR) return; // default-socket discovery (host-side usage)
  if (TMUX_SOCKET) {
    try { if (statSync(TMUX_SOCKET).isSocket()) return; } catch { /* vanished */ }
    TMUX_SOCKET = '';
  }
  TMUX_SOCKET = discoverSocket();
}

/**
 * List candidate `coding-*` tmux sessions, most-recently-active first.
 *
 * @returns {{name: string, activity: number}[]}
 */
function listCodingSessions() {
  try {
    const out = execFileSync(
      'tmux',
      tmuxArgs(['list-sessions', '-F', '#{session_activity} #{session_name}']),
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const sp = l.indexOf(' ');
        return { activity: parseInt(l.slice(0, sp), 10) || 0, name: l.slice(sp + 1) };
      })
      .filter((s) => s.name.startsWith(SESSION_PREFIX))
      .sort((a, b) => b.activity - a.activity);
  } catch {
    return [];
  }
}

/**
 * Adopt a tmux session as the active target: re-infer the agent (unless pinned via
 * LQM_AGENT), rebuild the extraction profile, and reset per-session state.
 *
 * @param {string} name  tmux session name
 */
function adoptSession(name) {
  if (name === SESSION) return;
  SESSION = name;
  const inferred = (name.match(/^coding-([a-zA-Z0-9]+)-/) || [])[1];
  AGENT = (process.env.LQM_AGENT || inferred || 'agent').toLowerCase();
  PROFILE = buildProfile(AGENT);
  SESSION_ID = process.env.SESSION_ID || `${AGENT}-${process.pid}`;
  // Reset per-session state so the new session starts clean.
  lastDraft = null;
  lastDraftAt = 0;
  lastSentQuery = null;
  lastSentAt = 0;
  lastNonEmptyDraft = null;
  process.stderr.write(`[live-query-monitor] adopted session='${SESSION}' agent='${AGENT}'\n`);
}

/**
 * Pick the most-recently-active `coding-*` session as the capture target.
 *
 * @returns {boolean} true when a session was adopted
 */
function detectSession() {
  const sessions = listCodingSessions();
  if (!sessions.length) return false;
  adoptSession(sessions[0].name);
  return true;
}

/**
 * Capture the agent pane as plain text. Returns '' on any failure (e.g. the
 * session has gone away), which the caller treats as "no draft".
 *
 * @returns {string}
 */
function capturePane() {
  try {
    return execFileSync('tmux', tmuxArgs(['capture-pane', '-p', '-t', SESSION]), {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * Build conversation context from the visible tmux pane for the *draft heading
 * display* (shown beneath the typed query on the dashboard). It is NOT sent to
 * retrieval — the retrieval query is the raw draft only.
 *
 * The live path has no JSONL transcript (the prompt is unsent), so the pane text
 * itself is the conversation analog. We strip the in-progress draft so the
 * context reflects prior turns only, collapse whitespace, and keep the tail.
 *
 * @param {string} pane   full `capture-pane -p` text
 * @param {string} draft  the current draft to exclude from context
 * @returns {string} a compact context summary ('' when nothing useful)
 */
function paneContext(pane, draft) {
  try {
    if (!pane) return '';
    let text = pane;
    if (draft) {
      const idx = text.lastIndexOf(draft);
      if (idx !== -1) text = text.slice(0, idx);
    }
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (!collapsed) return '';
    // Keep the tail (most recent turns) for the heading-bar context display.
    return collapsed.slice(-1000);
  } catch {
    return '';
  }
}

/** True when the target tmux session still exists. */
function sessionAlive() {
  try {
    execFileSync('tmux', tmuxArgs(['has-session', '-t', SESSION]), { stdio: 'ignore', timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

/**
 * POST a JSON payload to a dashboard live-context endpoint. Fail-open: resolves
 * regardless of outcome so the monitor never disrupts the CLI.
 *
 * @param {string} path  request path (e.g. '/api/live-context/query')
 * @param {object} payload  JSON body
 * @returns {Promise<void>}
 */
function postJson(path, payload) {
  return new Promise((resolve) => {
    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      resolve();
      return;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: DASHBOARD_PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        res.resume(); // drain
        res.on('end', resolve);
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

/**
 * POST the stable draft query to the dashboard for the full memory-pipeline pass
 * (Working + Observational retrieval). Fail-open.
 *
 * @param {string} query     the retrieval query — the raw typed draft (no enrichment)
 * @param {string} rawDraft  the original typed draft (for display / typing-match)
 */
function sendQuery(query, rawDraft) {
  return postJson('/api/live-context/query', {
    query,
    rawDraft,
    agent: AGENT,
    sessionId: SESSION_ID,
    tmuxSession: SESSION,
    project: PROJECT,
    cwd: PROJECT_DIR,
    budget: BUDGET,
    ts: new Date().toISOString(),
  });
}

/**
 * Stream the in-progress draft to the dashboard heading bar (no retrieval). An
 * empty string clears the heading when the input box empties. Fail-open.
 *
 * @param {string} query    current draft text ('' to clear)
 * @param {string} context  deterministic pane context for the draft ('' to clear)
 */
function sendDraft(query, context = '') {
  return postJson('/api/live-context/draft', {
    query,
    context: typeof context === 'string' ? context.slice(0, 300) : '',
    agent: AGENT,
    sessionId: SESSION_ID,
    project: PROJECT,
    ts: new Date().toISOString(),
  });
}

/**
 * Record a query the user actually submitted to the CLI (box cleared after Enter)
 * into the dashboard "Recent Queries" log. Fail-open.
 *
 * @param {string} query  the submitted query text
 */
function sendSubmitted(query) {
  return postJson('/api/live-context/submitted', {
    query,
    agent: AGENT,
    sessionId: SESSION_ID,
    project: PROJECT,
    ts: new Date().toISOString(),
  });
}

/**
 * One polling tick: snapshot → extract → stream draft / detect submit → maybe retrieve.
 */
async function tick() {
  if (stopped) return;

  // Resolve the host tmux socket (container reaches it via the .data mount).
  ensureSocket();

  // Resolve a session: in autodetect mode, scan for the current coding-* session.
  if (!SESSION) {
    if (!detectSession()) return; // nothing to watch yet — wait for a CLI to appear
  }

  if (!sessionAlive()) {
    if (AUTODETECT) {
      // The CLI exited (or restarted with a new pid). Clear the heading and drop
      // back to scanning so we automatically pick up the next coding-* session.
      process.stderr.write(`[live-query-monitor] session '${SESSION}' gone — rescanning\n`);
      sendDraft('', '');
      SESSION = null;
      TMUX_SOCKET = ''; // re-discover in case the tmux server also restarted
      return;
    }
    process.stderr.write(`[live-query-monitor] session '${SESSION}' gone — exiting\n`);
    shutdown();
    return;
  }

  const pane = capturePane();
  const draft = extractDraft(pane, PROFILE);
  const now = Date.now();

  if (draft !== lastDraft) {
    // Draft changed — reset the stability timer and react to the change.
    lastDraft = draft;
    lastDraftAt = now;

    if (draft == null || draft === '') {
      // Input box emptied. If we had a non-empty draft, treat the box clearing
      // as a submission (the user pressed Enter) and log it as a Recent Query.
      const submitted = lastNonEmptyDraft;
      lastNonEmptyDraft = null;
      // Clear the live heading regardless.
      sendDraft('', '');
      if (submitted && submitted.trim()) {
        process.stderr.write(`[live-query-monitor] submitted → "${submitted.slice(0, 80)}"\n`);
        sendSubmitted(submitted);
      }
    } else {
      // Still typing — stream the in-progress draft to the heading bar.
      lastNonEmptyDraft = draft;
      sendDraft(draft, paneContext(pane, draft));
    }
    return;
  }

  if (draft == null) return; // empty box — nothing to do

  const stableLongEnough = now - lastDraftAt >= STABLE_MS;
  const isNewQuery = draft !== lastSentQuery;
  const cooledDown = now - lastSentAt >= MIN_INTERVAL_MS;

  if (stableLongEnough && isNewQuery && cooledDown) {
    lastSentQuery = draft;
    lastSentAt = now;
    // Gate on substantive prompts (same threshold as the UserPromptSubmit hook).
    // The retrieval query is the raw draft only — no pane-context enrichment.
    // Pane context is still streamed to the heading bar (sendDraft) for display.
    if (!isSubstantivePrompt(draft)) {
      return;
    }
    process.stderr.write(`[live-query-monitor] query → "${draft.slice(0, 80)}"\n`);
    await sendQuery(draft, draft);
  }
}

// ---- Lifecycle --------------------------------------------------------------
let timer = null;

function loop() {
  tick().finally(() => {
    if (!stopped) timer = setTimeout(loop, POLL_MS);
  });
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  if (timer) clearTimeout(timer);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);

ensureSocket();
process.stderr.write(
  `[live-query-monitor] watching session='${SESSION || `auto(${SESSION_PREFIX}*)`}' agent='${AGENT}' ` +
  `→ dashboard :${DASHBOARD_PORT} (poll ${POLL_MS}ms, stable ${STABLE_MS}ms` +
  `${TMUX_SOCKET ? `, socket=${TMUX_SOCKET}` : TMUX_SOCKET_DIR ? `, socketDir=${TMUX_SOCKET_DIR}` : ''})\n`
);
loop();
