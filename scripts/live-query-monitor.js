#!/usr/bin/env node

/**
 * Live Query Monitor — preview Memory context for a *typed-but-unsent* CLI prompt.
 *
 * Runs on the host alongside a coding-agent tmux session (Copilot CLI, Claude
 * Code, or OpenCode). It periodically snapshots the agent's tmux pane with
 * `tmux capture-pane -p`, extracts the draft the user is currently typing (via
 * InputDraftExtractor), debounces until the draft is stable, and POSTs the query
 * to the Health Dashboard. The dashboard retrieves the matching Working +
 * Observational memory and broadcasts it to the "Live Context" tab.
 *
 * Why not a UserPromptSubmit hook? The prompt has not been submitted yet — it
 * only exists on screen — so the terminal snapshot is the single source of truth.
 *
 * Environment variables:
 *   LQM_SESSION          tmux session/target to capture (required)
 *   LQM_AGENT            agent name: copilot | claude | opencode (default: agent)
 *   LQM_DASHBOARD_PORT   dashboard API port (default: API_PORT from .env.ports or 3033)
 *   LQM_POLL_MS          poll interval ms (default 350)
 *   LQM_STABLE_MS        draft must be unchanged this long before retrieve (default 600)
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
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { extractDraft } from '../src/live-logging/InputDraftExtractor.js';

const SESSION = process.env.LQM_SESSION;
const AGENT = (process.env.LQM_AGENT || 'agent').toLowerCase();
const CODING_REPO = process.env.CODING_REPO || process.cwd();
const PROJECT_DIR = process.env.CODING_PROJECT_DIR || process.env.TARGET_PROJECT_DIR || process.cwd();
const PROJECT = basename(PROJECT_DIR);
const SESSION_ID = process.env.SESSION_ID || `${AGENT}-${process.pid}`;

const POLL_MS = intEnv('LQM_POLL_MS', 350);
const STABLE_MS = intEnv('LQM_STABLE_MS', 600);
const MIN_INTERVAL_MS = intEnv('LQM_MIN_INTERVAL_MS', 1200);
const BUDGET = intEnv('LQM_BUDGET', 1000);

if (!SESSION) {
  process.stderr.write('[live-query-monitor] LQM_SESSION not set — exiting\n');
  process.exit(0); // fail-open: do not error out the launcher
}

const DASHBOARD_PORT = resolveDashboardPort();

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
let stopped = false;

/**
 * Capture the agent pane as plain text. Returns '' on any failure (e.g. the
 * session has gone away), which the caller treats as "no draft".
 *
 * @returns {string}
 */
function capturePane() {
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-t', SESSION], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/** True when the target tmux session still exists. */
function sessionAlive() {
  try {
    execFileSync('tmux', ['has-session', '-t', SESSION], { stdio: 'ignore', timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

/**
 * POST the stable draft query to the dashboard. Fail-open: resolves regardless.
 *
 * @param {string} query
 */
function sendQuery(query) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      query,
      agent: AGENT,
      sessionId: SESSION_ID,
      tmuxSession: SESSION,
      project: PROJECT,
      cwd: PROJECT_DIR,
      budget: BUDGET,
      ts: new Date().toISOString(),
    });

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: DASHBOARD_PORT,
        path: '/api/live-context/query',
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
 * One polling tick: snapshot → extract → debounce → maybe retrieve.
 */
async function tick() {
  if (stopped) return;

  if (!sessionAlive()) {
    process.stderr.write(`[live-query-monitor] session '${SESSION}' gone — exiting\n`);
    shutdown();
    return;
  }

  const draft = extractDraft(capturePane(), AGENT);
  const now = Date.now();

  if (draft !== lastDraft) {
    // Draft changed (still typing) — reset the stability timer.
    lastDraft = draft;
    lastDraftAt = now;
    return;
  }

  if (draft == null) return; // empty box — nothing to do

  const stableLongEnough = now - lastDraftAt >= STABLE_MS;
  const isNewQuery = draft !== lastSentQuery;
  const cooledDown = now - lastSentAt >= MIN_INTERVAL_MS;

  if (stableLongEnough && isNewQuery && cooledDown) {
    lastSentQuery = draft;
    lastSentAt = now;
    process.stderr.write(`[live-query-monitor] query → "${draft.slice(0, 80)}"\n`);
    await sendQuery(draft);
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

process.stderr.write(
  `[live-query-monitor] watching session='${SESSION}' agent='${AGENT}' ` +
  `→ dashboard :${DASHBOARD_PORT} (poll ${POLL_MS}ms, stable ${STABLE_MS}ms)\n`
);
loop();
