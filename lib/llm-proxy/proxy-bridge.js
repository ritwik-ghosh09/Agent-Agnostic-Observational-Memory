/**
 * @local/llm-proxy/proxy-bridge — internal LLM routing server.
 *
 * Started by src/llm-proxy/llm-proxy.mjs (public front :12435) which sets
 * LLM_PROXY_PORT before importing this module. Binds 127.0.0.1:$LLM_PROXY_PORT
 * and serves:
 *   GET  /health                  → {ok, providers:{<name>:{available}}}
 *   GET  /v1/models               → model list for the active provider
 *   POST /v1/chat/completions     → OpenAI-compatible completion (fallback chain)
 *   POST /chat/completions        → alias of the above
 *
 * Provider fallback chain (first available wins):
 *   DMR (Docker Model Runner) → GROQ direct (if GROQ_API_KEY) → error.
 */

import http from 'http';
import { URL } from 'url';

const PORT = Number(process.env.LLM_PROXY_PORT || 12499);
const DMR_HOST = process.env.DMR_HOST || 'localhost';
const DMR_PORT = process.env.DMR_PORT || '12434';
const DMR_URL = `http://${DMR_HOST}:${DMR_PORT}/engines/v1`;
const GROQ_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-oss-20b';

async function probe(url, apiKey) {
    try {
        const res = await fetch(url.replace(/\/chat\/completions$/, '/models'), {
            signal: AbortSignal.timeout(2500),
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
        return res.ok || res.status < 500;
    } catch {
        return false;
    }
}

async function providerHealth() {
    const [dmr, groq] = await Promise.all([
        probe(`${DMR_URL}/chat/completions`),
        process.env.GROQ_API_KEY ? probe(GROQ_URL, process.env.GROQ_API_KEY) : Promise.resolve(false),
    ]);
    return {
        dmr: { available: dmr },
        groq: { available: groq },
    };
}

async function forwardChat(body) {
    const chain = [];
    if (await probe(`${DMR_URL}/chat/completions`)) {
        chain.push({ name: 'dmr', url: `${DMR_URL}/chat/completions`, headers: {} });
    }
    if (process.env.GROQ_API_KEY) {
        chain.push({
            name: 'groq',
            url: `${GROQ_URL}/chat/completions`,
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        });
    }
    if (!chain.length) throw new Error('no LLM provider configured');

    let lastError = null;
    for (const ep of chain) {
        try {
            const payload = { ...body, model: body.model || DEFAULT_MODEL };
            const res = await fetch(ep.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...ep.headers },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 120000)),
            });
            const text = await res.text();
            return { status: res.status, text };
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('all providers failed');
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    try {
        if (req.method === 'GET' && url.pathname === '/health') {
            const providers = await providerHealth();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, providers }));
            return;
        }
        if (req.method === 'GET' && url.pathname === '/v1/models') {
            const health = await providerHealth();
            const models = health.dmr.available ? [{ id: DEFAULT_MODEL }] : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: models }));
            return;
        }
        if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', async () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                    const out = await forwardChat(body);
                    res.writeHead(out.status, { 'Content-Type': 'application/json' });
                    res.end(out.text);
                } catch (err) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: err.message } }));
                }
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${url.pathname}` } }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[local-llm-proxy] bridge listening on http://127.0.0.1:${PORT}`);
});
