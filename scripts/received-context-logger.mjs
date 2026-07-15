#!/usr/bin/env node
/**
 * received-context-logger.mjs
 *
 * Aggregates what Copilot CLI ACTUALLY received (OpenTelemetry content capture,
 * attribute `gen_ai.input.messages`) into the SAME originally-tagged segregations
 * the KnowledgeInjection hook produced — Working Memory (Project / Components /
 * Milestone / Status / Current / Known Issues) and Observational Memory tiers
 * (Insight / Digest / Entity / Observation) — and writes ONE JSON record per
 * prompt submission to a JSONL log for HUMAN verification against Live Context.
 *
 * Trigger: one span == one prompt submission. Run as a Copilot hook
 * (userPromptSubmitted / agentStop / sessionEnd) or as a --watch daemon.
 * Offset-based + de-duplicated by (conversationId, spanTimestamp, query) so
 * repeated invocations never double-log a submission.
 *
 * Zero external dependencies (node:fs / node:http / node:path only).
 *
 * Enable Copilot content capture first (sensitive — trusted env only):
 *   export COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/otel.jsonl"
 *   export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
 *
 * Usage:
 *   node scripts/received-context-logger.mjs                 # one-shot: process new spans
 *   node scripts/received-context-logger.mjs --watch         # tail: log on every submission
 *   node scripts/received-context-logger.mjs --self-test     # parser self-test (no Copilot needed)
 *   node scripts/received-context-logger.mjs --otel <path> --log-dir <dir>
 *   node scripts/received-context-logger.mjs --no-live       # skip Live-Context best-effort join
 *
 * Author: Ritwik Ghosh · Intern · EF 412
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const SCHEMA_VERSION = 1;
const TAG_TO_TIER = { Insight: 'insights', Digest: 'digests', Entity: 'kg_entities', Observation: 'observations' };
const ITEM_MARKER = /^\*\*\[(Insight|Digest|Entity|Observation)\]\*\*/;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { watch: false, selfTest: false, live: true };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--watch') a.watch = true;
    else if (t === '--self-test') a.selfTest = true;
    else if (t === '--no-live') a.live = false;
    else if (t === '--otel') a.otel = argv[++i];
    else if (t === '--log-dir') a.logDir = argv[++i];
    else if (t === '--live-url') a.liveUrl = argv[++i];
  }
  return a;
}

function resolveOtelPath(arg) {
  return arg || process.env.COPILOT_OTEL_FILE_EXPORTER_PATH || path.join(os.homedir(), '.copilot', 'otel.jsonl');
}
function resolveLogDir(arg) {
  return arg || process.env.RECEIVED_CONTEXT_LOG_DIR
    || path.join(process.env.CODING_REPO || process.cwd(), '.data', 'received-context-log');
}

// ---------------------------------------------------------------------------
// OTLP attribute normalization — handle both OTLP JSON and flat shapes
// ---------------------------------------------------------------------------
function otlpValue(v) {
  if (v == null) return undefined;
  if (typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(otlpValue);
  if ('kvlistValue' in v) {
    const o = {};
    for (const kv of v.kvlistValue.values || []) o[kv.key] = otlpValue(kv.value);
    return o;
  }
  return v;
}

/** Return a flat { attrKey: value } map from a span in either OTLP or flat form. */
function spanAttributes(span) {
  const out = {};
  if (Array.isArray(span.attributes)) {
    for (const kv of span.attributes) out[kv.key] = otlpValue(kv.value);
  } else if (span.attributes && typeof span.attributes === 'object') {
    for (const [k, v] of Object.entries(span.attributes)) out[k] = otlpValue(v);
  }
  return out;
}

/** Yield every span object from one parsed OTLP-file JSON line, any nesting shape. */
function* spansFromLine(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj.resourceSpans)) {
    for (const rs of obj.resourceSpans)
      for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || [])
        for (const sp of ss.spans || []) yield sp;
    return;
  }
  if (Array.isArray(obj.spans)) { for (const sp of obj.spans) yield sp; return; }
  // Flat: the line itself is a span (has a name + attributes/gen_ai.* keys)
  if (obj.name || obj.attributes || obj['gen_ai.operation.name']) yield obj;
}

// ---------------------------------------------------------------------------
// Extract message texts from gen_ai.input.messages (string or array form)
// ---------------------------------------------------------------------------
function messageText(msg) {
  if (msg == null) return '';
  if (typeof msg === 'string') return msg;
  if (typeof msg.content === 'string') return msg.content;
  const parts = msg.parts || msg.content;
  if (Array.isArray(parts)) {
    return parts.map((p) => (typeof p === 'string' ? p : (p?.content ?? p?.text ?? ''))).join('\n');
  }
  return '';
}

function parseInputMessages(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return [{ role: 'unknown', text: raw }]; }
  }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map((m) => ({ role: (m && m.role) || 'unknown', text: messageText(m) }));
}

// ---------------------------------------------------------------------------
// Segregation of the injected block into originally-tagged structures
// ---------------------------------------------------------------------------
function sliceSection(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return null;
  const after = text.slice(start + heading.length);
  const next = after.search(/\n##\s/);
  return (next === -1 ? after : after.slice(0, next)).replace(/^\s*\n/, '');
}

function parseWorkingMemory(text) {
  const body = sliceSection(text, '## Working Memory');
  if (body == null) return { present: false };
  const wm = { present: true, raw: `## Working Memory\n${body}`.trim(), project: null, components: [], milestone: null, status: null, current: null, knownIssues: [] };
  let inIssues = false;
  for (const line of body.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let m;
    if ((m = l.match(/^\*\*Project:\*\*\s*(.+)$/))) { wm.project = m[1].trim(); inIssues = false; }
    else if ((m = l.match(/^\*\*Milestone:\*\*\s*(.+)$/))) { wm.milestone = m[1].trim(); inIssues = false; }
    else if ((m = l.match(/^\*\*Status:\*\*\s*(.+)$/))) { wm.status = m[1].trim(); inIssues = false; }
    else if ((m = l.match(/^\*\*Current:\*\*\s*(.+)$/))) { wm.current = m[1].trim(); inIssues = false; }
    else if (/^\*\*Known Issues:\*\*/.test(l)) { inIssues = true; }
    else if (l.startsWith('- ')) {
      if (inIssues) wm.knownIssues.push(l.slice(2).trim());
      else wm.components.push(l.slice(2).trim());
    }
  }
  return wm;
}

function parseObservationalMemory(text) {
  const body = sliceSection(text, '## Observational Memory');
  const om = { present: body != null, raw: body != null ? `## Observational Memory\n${body}`.trim() : null,
    insights: [], digests: [], kg_entities: [], observations: [], totalItems: 0 };
  if (body == null) return om;
  const lines = body.split('\n');
  let cur = null;
  const flush = () => { if (cur) { om[TAG_TO_TIER[cur.tag]].push(cur.text.trim()); om.totalItems++; cur = null; } };
  for (const line of lines) {
    const m = line.match(ITEM_MARKER);
    if (m) { flush(); cur = { tag: m[1], text: line }; }
    else if (cur) cur.text += `\n${line}`;
  }
  flush();
  return om;
}

/** Pick the user's actual typed query: last user message with the injected block stripped. */
function extractQuery(messages) {
  const userMsgs = messages.filter((m) => m.role === 'user' && m.text);
  const pick = userMsgs.length ? userMsgs[userMsgs.length - 1].text : (messages.find((m) => m.text)?.text || '');
  // Remove an injected system-reminder / memory block if it rode inside the user turn,
  // keeping the genuinely typed prompt (which may sit before OR after the block).
  let q = pick.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  // Drop any leftover bare memory sections (block injected without reminder tags).
  q = q.replace(/##\s+(Working|Observational) Memory[\s\S]*?(?=\n##\s|$)/g, ' ');
  return q.replace(/\s+/g, ' ').trim().slice(0, 500);
}

// ---------------------------------------------------------------------------
// Build one record per qualifying span
// ---------------------------------------------------------------------------
function buildRecord(span, attrs, otelPath) {
  const op = attrs['gen_ai.operation.name'];
  if (op !== 'invoke_agent' && op !== 'chat') return null;
  const rawMsgs = attrs['gen_ai.input.messages'];
  if (rawMsgs == null) return null; // content capture not enabled → nothing to verify

  const messages = parseInputMessages(rawMsgs);
  const injected = messages.find((m) => /##\s+Observational Memory|##\s+Working Memory/.test(m.text));
  const blockText = injected ? injected.text : messages.map((m) => m.text).join('\n');

  const workingMemory = parseWorkingMemory(blockText);
  const observationalMemory = parseObservationalMemory(blockText);
  const query = extractQuery(messages);

  const tsNanos = span.endTimeUnixNano || span.startTimeUnixNano;
  const spanTimestamp = tsNanos ? new Date(Number(BigInt(tsNanos) / 1000000n)).toISOString()
    : (attrs['timestamp'] || new Date().toISOString());

  return {
    schemaVersion: SCHEMA_VERSION,
    loggedAt: new Date().toISOString(),
    source: 'otel:gen_ai.input.messages',
    otelFile: otelPath,
    spanName: span.name || op,
    operation: op,
    conversationId: attrs['gen_ai.conversation.id'] || null,
    spanTimestamp,
    query,
    usage: {
      input_tokens: attrs['gen_ai.usage.input_tokens'] ?? null,
      output_tokens: attrs['gen_ai.usage.output_tokens'] ?? null,
      cache_read_input_tokens: attrs['gen_ai.usage.cache_read.input_tokens'] ?? null,
      cache_creation_input_tokens: attrs['gen_ai.usage.cache_creation.input_tokens'] ?? null,
    },
    received: {
      hasInjectedBlock: Boolean(injected),
      workingMemory,
      observationalMemory,
    },
    expectedFromLiveContext: null, // filled best-effort below
    verification: { status: 'PENDING_HUMAN', note: 'Human compares received.* against expectedFromLiveContext / dashboard Live Context.' },
  };
}

// ---------------------------------------------------------------------------
// Best-effort Live-Context join (fail-open) so the human sees both sides
// ---------------------------------------------------------------------------
function httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

function norm(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

async function attachLiveContext(record, liveUrl) {
  const data = await httpGetJson(`${liveUrl}/api/live-context?limit=50`);
  const entries = (data && data.data) || [];
  if (!entries.length) return;
  const q = norm(record.query);
  let best = null; let bestScore = 0;
  for (const e of entries) {
    const cand = norm(e.rawDraft || e.query);
    if (!cand) continue;
    let score = 0;
    if (cand === q) score = 1;
    else if (cand.includes(q) || q.includes(cand)) score = 0.8;
    else {
      const a = new Set(q.split(' ')); const b = new Set(cand.split(' '));
      const inter = [...a].filter((w) => b.has(w)).length;
      score = inter / Math.max(a.size, b.size, 1);
    }
    if (score > bestScore) { bestScore = score; best = e; }
  }
  if (best && bestScore >= 0.5) {
    record.expectedFromLiveContext = {
      matched: true, matchScore: Number(bestScore.toFixed(2)), query: best.rawDraft || best.query,
      meta: best.meta || null,
      rankedResults: (best.rankedResults || []).filter((r) => r.usedInObservational)
        .map((r) => ({ tier: r.tier, title: r.title, snippet: (r.snippet || '').slice(0, 160), usedInObservational: true })),
    };
  } else {
    record.expectedFromLiveContext = { matched: false, note: 'No Live-Context entry matched this query (>=0.5).' };
  }
}

// ---------------------------------------------------------------------------
// Log writing (JSONL, YYYY/MM buckets) + offset + de-dup
// ---------------------------------------------------------------------------
function recordKey(r) { return `${r.conversationId || ''}|${r.spanTimestamp}|${norm(r.query).slice(0, 80)}`; }

function logFileFor(logDir, iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear(); const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dir = path.join(logDir, String(y), m);
  fs.mkdirSync(dir, { recursive: true });
  const day = `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return path.join(dir, `received-context-${day}.jsonl`);
}

function loadState(logDir) {
  const p = path.join(logDir, '.offsets.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { offsets: {}, seen: [] }; }
}
function saveState(logDir, state) {
  fs.mkdirSync(logDir, { recursive: true });
  state.seen = state.seen.slice(-5000);
  fs.writeFileSync(path.join(logDir, '.offsets.json'), JSON.stringify(state, null, 2));
}

async function processFile(otelPath, logDir, opts) {
  if (!fs.existsSync(otelPath)) {
    process.stderr.write(`[received-context-logger] OTel file not found: ${otelPath}\n` +
      `  Enable it: export COPILOT_OTEL_FILE_EXPORTER_PATH="${otelPath}" OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true\n`);
    return 0;
  }
  const state = loadState(logDir);
  const seen = new Set(state.seen || []);
  const size = fs.statSync(otelPath).size;
  let offset = Number(state.offsets?.[otelPath] || 0);
  if (offset > size) offset = 0; // file rotated/truncated
  if (offset === size) return 0;

  const fd = fs.openSync(otelPath, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);

  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const consumable = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
  const lines = consumable.split('\n').filter((l) => l.trim());

  let written = 0;
  for (const line of lines) {
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    for (const span of spansFromLine(obj)) {
      const attrs = spanAttributes(span);
      const rec = buildRecord(span, attrs, otelPath);
      if (!rec) continue;
      const key = recordKey(rec);
      if (seen.has(key)) continue;
      if (opts.live) { try { await attachLiveContext(rec, opts.liveUrl); } catch { /* fail-open */ } }
      fs.appendFileSync(logFileFor(logDir, rec.loggedAt), JSON.stringify(rec) + '\n');
      seen.add(key); written++;
    }
  }

  state.offsets = state.offsets || {};
  state.offsets[otelPath] = offset + Buffer.byteLength(consumable, 'utf8');
  state.seen = [...seen];
  saveState(logDir, state);
  if (written) process.stdout.write(`[received-context-logger] wrote ${written} record(s)\n`);
  return written;
}

// ---------------------------------------------------------------------------
// Self-test — validate segregation without a live Copilot session
// ---------------------------------------------------------------------------
function selfTest() {
  const injected = [
    '## Working Memory',
    '**Project:** coding',
    '- **retrieval-service**: hybrid retrieval + RRF',
    '- **token-budget**',
    '**Milestone:** Phase 6',
    '**Status:** in progress',
    '**Current:** Deployed live context preview',
    '**Known Issues:**',
    '- WAL cache staleness on VirtioFS',
    '',
    '## Observational Memory',
    '',
    '**[Insight]** **ETM Docker Build Timeout Hardening** (confidence: 0.9)',
    'Raised build timeout; fire-and-forget write path avoids blocking.',
    '**[Digest]** **Retrieval relevance fixes** (2026-04-25, agents: claude)',
    'Topic pre-filtering + freshness rerank reduced noise.',
    '**[Observation]** *copilot* (2026-06-25, coding)',
    'Traced UserPromptSubmit -> retrieve() threshold ownership.',
  ].join('\n');

  const span = {
    name: 'invoke_agent', endTimeUnixNano: '1780000000000000000',
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
      { key: 'gen_ai.conversation.id', value: { stringValue: 'sess-selftest' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '4210' } },
      { key: 'gen_ai.usage.cache_read.input_tokens', value: { intValue: '1830' } },
      { key: 'gen_ai.input.messages', value: { stringValue: JSON.stringify([
        { role: 'system', content: 'You are Copilot.' },
        { role: 'user', content: `<system-reminder>\n${injected}\n</system-reminder>\nHow does the ETM avoid blocking the session?` },
      ]) } },
    ],
  };
  const rec = buildRecord(span, spanAttributes(span), '<self-test>');
  const wm = rec.received.workingMemory, om = rec.received.observationalMemory;
  const checks = [
    ['query extracted', rec.query.includes('ETM avoid blocking')],
    ['WM project', wm.project === 'coding'],
    ['WM components=2', wm.components.length === 2],
    ['WM milestone', wm.milestone === 'Phase 6'],
    ['WM knownIssues=1', wm.knownIssues.length === 1],
    ['OM insights=1', om.insights.length === 1],
    ['OM digests=1', om.digests.length === 1],
    ['OM observations=1', om.observations.length === 1],
    ['OM totalItems=3', om.totalItems === 3],
    ['usage input_tokens', rec.usage.input_tokens === 4210],
    ['usage cache_read', rec.usage.cache_read_input_tokens === 1830],
  ];
  let ok = true;
  for (const [name, pass] of checks) { process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${name}\n`); if (!pass) ok = false; }
  process.stdout.write(ok ? 'SELF-TEST: PASS\n' : 'SELF-TEST: FAIL\n');
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  if (args.selfTest) return selfTest();

  const otelPath = resolveOtelPath(args.otel);
  const logDir = resolveLogDir(args.logDir);
  const opts = { live: args.live, liveUrl: args.liveUrl || process.env.LIVE_CONTEXT_URL || 'http://localhost:3033' };

  await processFile(otelPath, logDir, opts);

  if (args.watch) {
    process.stdout.write(`[received-context-logger] watching ${otelPath}\n  → ${logDir}\n`);
    let busy = false;
    const run = async () => { if (busy) return; busy = true; try { await processFile(otelPath, logDir, opts); } finally { busy = false; } };
    try { fs.watch(path.dirname(otelPath), () => run()); } catch { /* dir may not exist yet */ }
    setInterval(run, 3000); // poll fallback (fs.watch is unreliable for appends)
  }
}

main().catch((e) => { process.stderr.write(`[received-context-logger] ${e?.stack || e}\n`); process.exit(0); });
