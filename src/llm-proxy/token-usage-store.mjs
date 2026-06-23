/**
 * Token-Usage Store — repo-owned persistence + aggregation for the LLM proxy.
 *
 * The published `@rapid/llm-proxy` package (port 12435) only serves /health,
 * /api/complete and /raas-job/*. The Health Dashboard's Token Usage page expects
 * the proxy to additionally serve /api/token-usage/summary and
 * /api/token-usage/recent. This module supplies the persistence + aggregation so
 * the repo wrapper (src/llm-proxy/llm-proxy.mjs) can expose those endpoints.
 *
 * Storage mirrors the documented LSL convention: one JSON file per user per hour
 * window under .data/llm-proxy-export/YYYY/MM/YYYY-MM-DD_HHMM-HHMM_<hash6>.json.
 * Files are hydrated on boot and merged idempotently (user_hash + id).
 *
 * Pure JS — no native dependencies — so it works on Linux, macOS and Windows.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ALL_PROVIDERS = ['claude-code', 'copilot', 'anthropic', 'openai', 'groq'];

const DEFAULT_PROVIDER_MODELS = {
  'claude-code': ['claude-sonnet-4.6', 'claude-haiku-4.5', 'claude-opus-4.6'],
  'copilot': ['claude-sonnet-4.6', 'claude-haiku-4.5', 'claude-opus-4.6', 'gpt-4o'],
  'anthropic': ['claude-sonnet-4.6', 'claude-haiku-4.5', 'claude-opus-4.6'],
  'openai': ['gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  'groq': ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
};

const SUBSCRIPTION_BY_PROVIDER = {
  'copilot': 'copilot-subscription',
  'claude-code': 'max-subscription',
  'anthropic': 'api-key',
  'openai': 'api-key',
  'groq': 'api-key',
};

/** Resolve the repository root the proxy runs in. */
function resolveRepoRoot() {
  if (process.env.CODING_REPO && fs.existsSync(process.env.CODING_REPO)) {
    return process.env.CODING_REPO;
  }
  // Walk up from this module looking for a package.json / .data dir.
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Deterministic 6-char hex hash identifying the contributor. */
function resolveUserHash() {
  if (process.env.LLM_PROXY_USER_HASH) {
    return String(process.env.LLM_PROXY_USER_HASH).slice(0, 6);
  }
  let seed = 'unknown';
  try {
    seed = `${os.userInfo().username}@${os.hostname()}`;
  } catch {
    seed = `${process.env.USER || process.env.USERNAME || 'unknown'}@${process.env.HOSTNAME || 'host'}`;
  }
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 6);
}

/** Two-digit zero pad. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Build the current hour window descriptor in LOCAL time.
 * Returns { date: 'YYYY-MM-DD', window: 'HHMM-HHMM' }.
 */
function hourWindow(d = new Date()) {
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const h = d.getHours();
  const next = (h + 1) % 24;
  return {
    year: String(y),
    month: mo,
    date: `${y}-${mo}-${da}`,
    window: `${pad2(h)}00-${pad2(next)}00`,
  };
}

/**
 * Canonicalize an upstream model name so the dashboard's By-Model panel does not
 * fragment across spellings of the same model. e.g. `claude-sonnet-4-6`,
 * `Claude Sonnet 4.6`, `claude-sonnet-4-6-20250930`, bare `sonnet` all collapse.
 */
export function canonicalizeModelName(raw) {
  if (!raw) return 'unknown';
  let s = String(raw).trim().toLowerCase();
  // Strip trailing date snapshot (e.g. -20251001).
  s = s.replace(/-?20\d{6}$/, '');
  // Title-case "Claude Sonnet 4.6" -> "claude sonnet 4.6" -> dashed.
  s = s.replace(/\s+/g, '-');
  // claude-<family>-<maj>[-.]<min>  ->  claude-<family>-<maj>.<min>
  const m = s.match(/claude-(opus|sonnet|haiku)-(\d+)[-.](\d+)/);
  if (m) return `claude-${m[1]}-${m[2]}.${m[3]}`;
  // Bare family name (CLI fallback when modelUsage empty).
  const bare = s.match(/^(opus|sonnet|haiku)$/);
  if (bare) return `claude-${bare[1]}`;
  return s;
}

function subscriptionForProvider(provider) {
  return SUBSCRIPTION_BY_PROVIDER[provider] || 'api-key';
}

/** Adaptive bucket size (minutes) for a given window in hours. */
function bucketMinutesFor(hours) {
  if (hours == null) return 360;        // "all"
  if (hours <= 24) return 2;
  if (hours <= 48) return 10;
  if (hours <= 168) return 30;
  if (hours <= 720) return 120;
  return 360;
}

export class TokenUsageStore {
  constructor(opts = {}) {
    this.repoRoot = opts.repoRoot || resolveRepoRoot();
    this.userHash = opts.userHash || resolveUserHash();
    this.exportDir = path.join(this.repoRoot, '.data', 'llm-proxy-export');
    this.dbDir = path.join(this.repoRoot, '.data', 'llm-proxy');
    this.settingsPath = path.join(this.dbDir, 'settings.json');
    this.records = [];
    this.seen = new Set();              // `${user_hash}:${id}` dedup keys
    this.nextId = 1;
    this.dirtyFiles = new Set();        // export file paths needing a flush
    this.flushTimer = null;
    this.settings = { processOverrides: {}, providerModels: { ...DEFAULT_PROVIDER_MODELS } };
    this._ensureDirs();
    this._hydrate();
    this._loadSettings();
  }

  _ensureDirs() {
    for (const d of [this.exportDir, this.dbDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch { /* non-fatal */ }
    }
  }

  log(msg) {
    process.stdout.write(`[token-usage] ${msg}\n`);
  }

  // --- Hydration ------------------------------------------------------------

  _walkJsonFiles(dir) {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...this._walkJsonFiles(full));
      else if (e.isFile() && e.name.endsWith('.json')) out.push(full);
    }
    return out;
  }

  _hydrate() {
    const files = this._walkJsonFiles(this.exportDir);
    let attempted = 0;
    let inserted = 0;
    let maxOwnId = 0;
    for (const file of files) {
      let rows;
      try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        attempted++;
        const userHash = row.user_hash || 'unknown';
        const id = Number(row.id) || 0;
        const key = `${userHash}:${id}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        this.records.push({ ...row, user_hash: userHash, id });
        inserted++;
        if (userHash === this.userHash && id > maxOwnId) maxOwnId = id;
      }
    }
    this.nextId = maxOwnId + 1;
    this.log(`hydrate: read ${files.length} files, attempted ${attempted} inserts, ${inserted} retained`);
  }

  // --- Recording ------------------------------------------------------------

  /**
   * Record one completion. `body` is the /api/complete request body; `result`
   * is the upstream JSON response { content, provider, model, tokens, latencyMs }.
   */
  record(body, result) {
    if (!result) return null;
    const provider = result.provider || body.provider || 'unknown';
    const modelRaw = result.model || body.model || 'unknown';
    const tokens = result.tokens || {};
    let input = Number(tokens.input) || 0;
    let output = Number(tokens.output) || 0;
    let total = Number(tokens.total) || (input + output);
    let estimated = 0;
    if (total === 0) {
      // Estimate from text length (~4 chars/token) when upstream returned nothing.
      const promptLen = this._promptText(body).length;
      const replyLen = (result.content || '').length;
      input = Math.round(promptLen / 4);
      output = Math.round(replyLen / 4);
      total = input + output;
      estimated = 1;
    }
    const rec = {
      id: this.nextId++,
      user_hash: this.userHash,
      timestamp: new Date().toISOString(),
      provider,
      model: canonicalizeModelName(modelRaw),
      model_raw: modelRaw,
      process: body.process || 'unknown',
      subscription: subscriptionForProvider(provider),
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      latency_ms: Number(result.latencyMs) || 0,
      prompt_preview: this._promptPreview(body),
      tokens_estimated: estimated,
    };
    this.seen.add(`${rec.user_hash}:${rec.id}`);
    this.records.push(rec);
    this._scheduleFlush(rec.timestamp);
    return rec;
  }

  _promptText(body) {
    const messages = body.messages || [];
    const userMsg = [...messages].reverse().find(m => m && m.role !== 'system');
    const content = userMsg ? userMsg.content : (messages[0] && messages[0].content) || '';
    return typeof content === 'string' ? content : JSON.stringify(content || '');
  }

  _promptPreview(body) {
    return this._promptText(body)
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  // --- Persistence ----------------------------------------------------------

  _exportFileFor(date) {
    const w = hourWindow(date);
    const dir = path.join(this.exportDir, w.year, w.month);
    const name = `${w.date}_${w.window}_${this.userHash}.json`;
    return path.join(dir, name);
  }

  _scheduleFlush(timestamp) {
    this.dirtyFiles.add(this._exportFileFor(new Date(timestamp)));
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 1500);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /** Write all dirty hour-files to disk (full rewrite of own-user rows). */
  flush() {
    const files = [...this.dirtyFiles];
    this.dirtyFiles.clear();
    for (const file of files) {
      const w = path.basename(file);
      // Collect this user's rows whose hour-window matches this file.
      const rows = this.records.filter(r =>
        r.user_hash === this.userHash &&
        path.basename(this._exportFileFor(new Date(r.timestamp))) === w
      );
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(rows, null, 2));
      } catch (err) {
        this.log(`flush failed for ${file}: ${err.message}`);
      }
    }
  }

  // --- Settings -------------------------------------------------------------

  _loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      this.settings = {
        processOverrides: raw.processOverrides || {},
        providerModels: raw.providerModels && Object.keys(raw.providerModels).length
          ? raw.providerModels
          : { ...DEFAULT_PROVIDER_MODELS },
      };
    } catch {
      // No file yet — keep defaults.
    }
  }

  saveSettings(next) {
    this.settings = {
      processOverrides: (next && next.processOverrides) || {},
      providerModels: (next && next.providerModels && Object.keys(next.providerModels).length)
        ? next.providerModels
        : { ...DEFAULT_PROVIDER_MODELS },
    };
    try {
      fs.mkdirSync(this.dbDir, { recursive: true });
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      this.log(`saveSettings failed: ${err.message}`);
    }
    return this.settings;
  }

  /** Hard-pin lookup for a process; returns { provider, model } or null. */
  overrideFor(process) {
    const o = this.settings.processOverrides[process];
    return o && (o.provider || o.model) ? o : null;
  }

  settingsResponse(availableProviders) {
    const processes = new Set(Object.keys(this.settings.processOverrides));
    for (const r of this.records) processes.add(r.process || 'unknown');
    return {
      settings: this.settings,
      processes: [...processes].sort(),
      availableProviders: availableProviders || [],
      allProviders: ALL_PROVIDERS,
    };
  }

  // --- Aggregation ----------------------------------------------------------

  /** Filter records to the requested window. `hours` null means "all". */
  _windowRecords(hours) {
    if (hours == null) return this.records;
    const cutoff = Date.now() - hours * 3600 * 1000;
    return this.records.filter(r => new Date(r.timestamp).getTime() >= cutoff);
  }

  recent(limit = 50) {
    const sorted = [...this.records].sort((a, b) => {
      const t = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      return t !== 0 ? t : (b.id - a.id);
    });
    return sorted.slice(0, limit).map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      provider: r.provider,
      model: r.model,
      process: r.process,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      total_tokens: r.total_tokens,
      latency_ms: r.latency_ms,
      subscription: r.subscription,
      prompt_preview: r.prompt_preview,
    }));
  }

  summary(hours) {
    const rows = this._windowRecords(hours);
    const bucketMin = bucketMinutesFor(hours);

    let totalInput = 0, totalOutput = 0, totalTokens = 0, totalLatency = 0;
    const byProcess = new Map();
    const byProvider = new Map();
    const byModel = new Map();
    const bySub = new Map();
    const buckets = new Map();          // bucketKey -> {calls,input,output}
    const procBuckets = new Map();      // bucketKey -> Map(process -> tokens)
    const modelBuckets = new Map();     // bucketKey -> Map(model -> tokens)
    const procTotals = new Map();
    const modelTotals = new Map();

    const bucketMs = bucketMin * 60 * 1000;

    for (const r of rows) {
      totalInput += r.input_tokens;
      totalOutput += r.output_tokens;
      totalTokens += r.total_tokens;
      totalLatency += r.latency_ms;

      const p = byProcess.get(r.process) || { process: r.process, calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, _latency: 0 };
      p.calls++; p.input_tokens += r.input_tokens; p.output_tokens += r.output_tokens; p.total_tokens += r.total_tokens; p._latency += r.latency_ms;
      byProcess.set(r.process, p);

      const pv = byProvider.get(r.provider) || { provider: r.provider, calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      pv.calls++; pv.input_tokens += r.input_tokens; pv.output_tokens += r.output_tokens; pv.total_tokens += r.total_tokens;
      byProvider.set(r.provider, pv);

      const md = byModel.get(r.model) || { model: r.model, calls: 0, total_tokens: 0 };
      md.calls++; md.total_tokens += r.total_tokens;
      byModel.set(r.model, md);

      const sb = bySub.get(r.subscription) || { subscription: r.subscription, calls: 0, total_tokens: 0 };
      sb.calls++; sb.total_tokens += r.total_tokens;
      bySub.set(r.subscription, sb);

      const t = new Date(r.timestamp).getTime();
      const bucketStart = Math.floor(t / bucketMs) * bucketMs;
      const key = new Date(bucketStart).toISOString();

      const b = buckets.get(key) || { calls: 0, input: 0, output: 0 };
      b.calls++; b.input += r.input_tokens; b.output += r.output_tokens;
      buckets.set(key, b);

      const pb = procBuckets.get(key) || new Map();
      pb.set(r.process, (pb.get(r.process) || 0) + r.total_tokens);
      procBuckets.set(key, pb);

      const mb = modelBuckets.get(key) || new Map();
      mb.set(r.model, (mb.get(r.model) || 0) + r.total_tokens);
      modelBuckets.set(key, mb);

      procTotals.set(r.process, (procTotals.get(r.process) || 0) + r.total_tokens);
      modelTotals.set(r.model, (modelTotals.get(r.model) || 0) + r.total_tokens);
    }

    const totalCalls = rows.length;

    const by_process = [...byProcess.values()]
      .map(p => ({
        process: p.process,
        calls: p.calls,
        input_tokens: p.input_tokens,
        output_tokens: p.output_tokens,
        total_tokens: p.total_tokens,
        avg_latency: p.calls ? Math.round(p._latency / p.calls) : 0,
      }))
      .sort((a, b) => b.total_tokens - a.total_tokens);

    const by_provider = [...byProvider.values()].sort((a, b) => b.total_tokens - a.total_tokens);
    const by_model = [...byModel.values()].sort((a, b) => b.total_tokens - a.total_tokens);
    const by_subscription = [...bySub.values()].sort((a, b) => b.total_tokens - a.total_tokens);

    // Zero-filled time buckets across the spanned range.
    const by_hour = [];
    const sortedKeys = [...buckets.keys()].sort();
    if (sortedKeys.length) {
      const startMs = new Date(sortedKeys[0]).getTime();
      const endMs = new Date(sortedKeys[sortedKeys.length - 1]).getTime();
      for (let t = startMs; t <= endMs; t += bucketMs) {
        const key = new Date(t).toISOString();
        const b = buckets.get(key);
        by_hour.push({
          hour: key,
          calls: b ? b.calls : 0,
          input_tokens: b ? b.input : 0,
          output_tokens: b ? b.output : 0,
        });
      }
    }

    // Ranked keys for the stacked Evolution chart (top consumers first).
    const process_keys = [...procTotals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const model_keys = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);

    const pivot = (bucketMap, keys) => by_hour.map(({ hour }) => {
      const row = { hour };
      const m = bucketMap.get(hour);
      for (const k of keys) row[k] = (m && m.get(k)) || 0;
      return row;
    });

    return {
      total_calls: totalCalls,
      total_input: totalInput,
      total_output: totalOutput,
      total_tokens: totalTokens,
      avg_latency_ms: totalCalls ? Math.round(totalLatency / totalCalls) : 0,
      by_process,
      by_provider,
      by_model,
      by_subscription,
      by_hour,
      hours: hours == null ? undefined : hours,
      bucket_minutes: bucketMin,
      process_keys,
      model_keys,
      by_process_hour: pivot(procBuckets, process_keys),
      by_model_hour: pivot(modelBuckets, model_keys),
    };
  }
}

export { ALL_PROVIDERS, DEFAULT_PROVIDER_MODELS };
