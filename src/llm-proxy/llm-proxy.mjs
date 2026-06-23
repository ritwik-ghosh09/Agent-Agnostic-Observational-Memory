#!/usr/bin/env node
/**
 * LLM Proxy Bridge — repo wrapper with Token-Usage telemetry.
 *
 * The canonical proxy logic lives in the standalone `@rapid/llm-proxy` package
 * (provider routing, circuit breaking, caching, completion). The published
 * package, however, does NOT expose the token-usage endpoints that the Health
 * Dashboard's Token Usage page reads directly from port 12435:
 *
 *   GET  /api/token-usage/summary?hours=N
 *   GET  /api/token-usage/recent?limit=50
 *   GET  /api/llm/settings
 *   PUT  /api/llm/settings
 *
 * This wrapper fixes that without forking the package:
 *   1. The upstream package is started on an INTERNAL port (public + 1) by
 *      overriding LLM_PROXY_PORT before importing it.
 *   2. A FRONT server binds the public port (default 12435) and:
 *        - transparently proxies /health, /api/complete, /raas-job/* upstream,
 *        - intercepts /api/complete to apply per-process provider pins and to
 *          record token usage from the upstream response,
 *        - serves the token-usage + llm-settings endpoints from a local store.
 *
 * Pure Node core + the local store module -> cross-platform (Linux/macOS/Windows).
 *
 * Usage:
 *   node src/llm-proxy/llm-proxy.mjs                  # public port 12435
 *   LLM_PROXY_PORT=9000 node src/llm-proxy/llm-proxy.mjs
 */

import http from 'node:http';
import net from 'node:net';
import { TokenUsageStore } from './token-usage-store.mjs';

const PUBLIC_PORT = parseInt(
  process.env.LLM_PROXY_PORT || process.env.LLM_CLI_PROXY_PORT || '12435',
  10,
);

const log = (...a) => process.stdout.write(`[llm-proxy-front] ${a.join(' ')}\n`);
const logErr = (...a) => process.stderr.write(`[llm-proxy-front] ${a.join(' ')}\n`);

/** Ask the OS for a free TCP port (bind :0, read assigned port, release). */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Pick a collision-free INTERNAL port for the upstream package. The 124xx range
// hosts several adjacent services (DMR 12434, obs-api 12436, …), so a fixed
// PUBLIC+1 offset is unsafe — probe the OS for a guaranteed-free port instead.
const INTERNAL_PORT = await findFreePort();

// Redirect the upstream package to the internal port BEFORE importing it.
process.env.LLM_PROXY_PORT = String(INTERNAL_PORT);

// Start the canonical proxy bridge (binds INTERNAL_PORT via LLM_PROXY_PORT).
await import('@rapid/llm-proxy/proxy-bridge');

const store = new TokenUsageStore();

// --- helpers ----------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/** Forward a buffered request to the internal upstream and return its response. */
function forward({ method, path: urlPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const upstreamHeaders = { ...headers };
    delete upstreamHeaders.host;
    if (body != null) {
      upstreamHeaders['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { host: '127.0.0.1', port: INTERNAL_PORT, method, path: urlPath, headers: upstreamHeaders },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode || 502, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

/** Provider availability snapshot from the upstream /health endpoint. */
async function availableProviders() {
  try {
    const r = await forward({ method: 'GET', path: '/health', headers: {} });
    const health = JSON.parse(r.body);
    return Object.entries(health.providers || {})
      .filter(([, v]) => v && v.available)
      .map(([k]) => k);
  } catch {
    return [];
  }
}

// --- front server -----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // CORS preflight.
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    // --- Token-usage endpoints (served locally) ---
    if (method === 'GET' && url.startsWith('/api/token-usage/summary')) {
      const q = new URL(url, 'http://localhost').searchParams;
      const hoursRaw = q.get('hours');
      const hours = (!hoursRaw || hoursRaw === 'all') ? null : parseInt(hoursRaw, 10);
      return sendJson(res, 200, store.summary(Number.isNaN(hours) ? 24 : hours));
    }

    if (method === 'GET' && url.startsWith('/api/token-usage/recent')) {
      const q = new URL(url, 'http://localhost').searchParams;
      const limit = parseInt(q.get('limit') || '50', 10) || 50;
      return sendJson(res, 200, { data: store.recent(limit) });
    }

    // --- LLM routing settings ---
    if (method === 'GET' && url === '/api/llm/settings') {
      const providers = await availableProviders();
      return sendJson(res, 200, store.settingsResponse(providers));
    }

    if (method === 'PUT' && url === '/api/llm/settings') {
      const raw = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      store.saveSettings(parsed);
      const providers = await availableProviders();
      return sendJson(res, 200, store.settingsResponse(providers));
    }

    // --- /api/complete: apply pins, forward, record token usage ---
    if (method === 'POST' && url === '/api/complete') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }

      // Hard-pin: a per-process override wins over body.provider.
      const override = store.overrideFor(body.process);
      if (override) {
        if (override.provider) body.provider = override.provider;
        if (override.model) body.model = override.model;
      }
      const outBody = JSON.stringify(body);

      const upstream = await forward({
        method: 'POST',
        path: '/api/complete',
        headers: { 'content-type': 'application/json' },
        body: outBody,
      });

      // Record only on a successful completion.
      if (upstream.status === 200) {
        try {
          const result = JSON.parse(upstream.body);
          store.record(body, result);
        } catch (err) {
          logErr(`record failed: ${err.message}`);
        }
      }

      res.writeHead(upstream.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(upstream.body);
    }

    // --- Everything else: transparent passthrough ---
    const raw = (method === 'GET' || method === 'HEAD') ? null : await readBody(req);
    const upstream = await forward({ method, path: url, headers: req.headers, body: raw });
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(upstream.body);
  } catch (err) {
    logErr(`request error: ${err.message}`);
    return sendJson(res, 502, { error: 'Upstream proxy unreachable', details: err.message });
  }
});

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
  log(`Token-usage front proxy listening on http://0.0.0.0:${PUBLIC_PORT} (upstream :${INTERNAL_PORT})`);
});

// Without an 'error' handler, a listen failure (e.g. EADDRINUSE when a previous
// instance has not yet released the port) is emitted as an unhandled 'error'
// event and crashes the process with a noisy stack trace. Exit cleanly instead;
// the health-coordinator's liveness watchdog will respawn us once the port frees.
server.on('error', (err) => {
  logErr(`front server error: ${err.code || ''} ${err.message}`.trim());
  process.exit(1);
});

function shutdown() {
  try { store.flush(); } catch { /* best effort */ }
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
