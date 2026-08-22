/**
 * @local/llm-proxy — self-contained LLMService implementation.
 *
 * Talks to any OpenAI-compatible chat-completions endpoint. Endpoint
 * resolution order (first configured wins):
 *   1. LLM_PROXY_URL        — host-side LLM CLI proxy (:12435)
 *   2. DMR_HOST/DMR_PORT    — Docker Model Runner (/engines/v1)
 *   3. OPENAI_BASE_URL      — generic OpenAI-compatible gateway
 *
 * Consumed surface (mirrors the previous dependency):
 *   initialize(), complete(), getAvailableProviders(), getMetricsTracker(),
 *   setRepositoryPath(), setModeResolver(), setMockService(), on() [EventEmitter]
 */

import { EventEmitter } from 'events';
import fs from 'fs';

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);

function resolveEndpoints() {
    const endpoints = [];
    if (process.env.LLM_PROXY_URL) {
        endpoints.push({ name: 'llm-proxy', url: `${process.env.LLM_PROXY_URL.replace(/\/$/, '')}/v1/chat/completions` });
    } else if (process.env.LLM_CLI_PROXY === 'enabled' || process.env.LLM_PROXY === 'local') {
        endpoints.push({ name: 'llm-proxy', url: 'http://localhost:12435/v1/chat/completions' });
    }
    const dmrHost = process.env.DMR_HOST || 'localhost';
    const dmrPort = process.env.DMR_PORT || '12434';
    endpoints.push({
        name: 'dmr',
        url: `http://${dmrHost}:${dmrPort}/engines/v1/chat/completions`,
    });
    if (process.env.OPENAI_BASE_URL) {
        endpoints.push({
            name: 'openai-compatible',
            url: `${process.env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
            apiKey: process.env.OPENAI_API_KEY,
        });
    }
    return endpoints;
}

export class LLMService extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.opts = opts;
        this.initialized = false;
        this.mockService = null;
        this.repositoryPath = process.env.REPOSITORY_PATH || process.cwd();
        this.modeResolver = null;
        this.providers = [];
        this.metrics = {
            requests: 0,
            completions: 0,
            errors: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            startedAt: new Date().toISOString(),
        };
    }

    async initialize(_opts = {}) {
        if (this.initialized) return this;
        // Probe endpoints so getAvailableProviders() reflects reality.
        this.endpoints = [];
        for (const ep of resolveEndpoints()) {
            try {
                const ctrl = AbortSignal.timeout(3000);
                const res = await fetch(ep.url.replace(/\/chat\/completions$/, '/models'), { signal: ctrl });
                this.endpoints.push({ ...ep, healthy: res.ok || res.status < 500 });
            } catch {
                this.endpoints.push({ ...ep, healthy: false });
            }
        }
        this.providers = this.endpoints.filter((e) => e.healthy).map((e) => e.name);
        this.initialized = true;
        this.emit('initialized', { providers: this.providers });
        return this;
    }

    getAvailableProviders() {
        return [...this.providers];
    }

    getMetricsTracker() {
        const metrics = this.metrics;
        return {
            getSnapshot: () => ({ ...metrics }),
            getUsageSummary: () => ({
                requests: metrics.requests,
                completions: metrics.completions,
                errors: metrics.errors,
                tokens: metrics.totalPromptTokens + metrics.totalCompletionTokens,
            }),
        };
    }

    setRepositoryPath(p) {
        this.repositoryPath = p;
    }

    setModeResolver(fn) {
        this.modeResolver = typeof fn === 'function' ? fn : null;
    }

    setMockService(svc) {
        this.mockService = svc;
    }

    /**
     * Complete a prompt.
     * @param {string|Array<{role:string,content:string}>} input
     * @param {{provider?:string, model?:string, temperature?:number, maxTokens?:number, json?:boolean}} opts
     */
    async complete(input, opts = {}) {
        this.metrics.requests += 1;
        if (this.mockService) {
            const out = await this.mockService.complete?.(input, opts);
            this.metrics.completions += 1;
            this.emit('complete', { usage: out?.usage ?? {} });
            return out ?? '';
        }

        const messages =
            typeof input === 'string'
                ? [{ role: 'user', content: input }]
                : Array.isArray(input)
                    ? input
                    : [{ role: 'user', content: String(input ?? '') }];

        await this.initialize();
        const candidates = [
            ...(opts.provider
                ? this.endpoints.filter((e) => e.name === opts.provider)
                : []),
            ...this.endpoints,
        ];

        let lastError = null;
        for (const ep of candidates) {
            try {
                const body = {
                    model: opts.model || process.env.LLM_MODEL || 'gpt-oss-20b',
                    messages,
                    temperature: opts.temperature ?? 0.4,
                    max_tokens: opts.maxTokens ?? Number(process.env.LLM_MAX_TOKENS || 4096),
                };
                if (opts.json) body.response_format = { type: 'json_object' };

                const res = await fetch(ep.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
                const data = await res.json();
                const choice = data.choices?.[0]?.message?.content ?? '';
                const usage = data.usage ?? {};
                this.metrics.completions += 1;
                this.metrics.totalPromptTokens += usage.prompt_tokens ?? 0;
                this.metrics.totalCompletionTokens += usage.completion_tokens ?? 0;
                const result = {
                    content: choice,
                    text: choice,
                    provider: ep.name,
                    model: data.model ?? body.model,
                    usage,
                };
                this.emit('complete', { usage, provider: ep.name });
                return result;
            } catch (err) {
                lastError = err;
                this.metrics.errors += 1;
                this.emit('error', err);
            }
        }
        throw new Error(`@local/llm-proxy: no LLM endpoint reachable (${lastError?.message ?? 'none configured'})`);
    }
}

/** Persist the metrics snapshot to a JSON file (helper used by tooling). */
export function writeMetricsSnapshot(service, file) {
    const snapshot = service.getMetricsTracker().getSnapshot();
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    return snapshot;
}

export default LLMService;
