/** Type declarations for @local/llm-proxy. */
import { EventEmitter } from 'events';

export interface LLMCompletionResult {
    content: string;
    text: string;
    provider: string;
    model: string;
    tokens?: number;
    usage: Record<string, number> & { total_tokens?: number };
    [k: string]: unknown;
}

export declare class LLMService extends EventEmitter {
    constructor(opts?: Record<string, unknown>);
    initialize(opts?: Record<string, unknown>): Promise<this>;
    complete(
        input:
            | string
            | Array<{ role: string; content: string }>
            | { messages: Array<{ role: string; content: string }>; [k: string]: unknown },
        opts?: Record<string, unknown>,
    ): Promise<LLMCompletionResult>;
    getAvailableProviders(): string[];
    getMetricsTracker(): {
        getSnapshot(): Record<string, unknown>;
        getUsageSummary(): Record<string, unknown>;
    };
    setRepositoryPath(p: string): void;
    setModeResolver(fn: unknown): void;
    setMockService(svc: unknown): void;
}
declare const _default: typeof LLMService;
export default _default;
