#!/usr/bin/env node
/**
 * LLM Proxy Bridge — thin wrapper
 *
 * Delegates to @rapid/llm-proxy proxy-bridge server.
 * All provider management, SDK loading, circuit breaking, and caching
 * handled by the standalone package.
 *
 * Usage:
 *   node src/llm-proxy/llm-proxy.mjs                  # default port 8089
 *   LLM_PROXY_PORT=9000 node src/llm-proxy/llm-proxy.mjs
 */

// Import and start the canonical proxy bridge from the standalone package.
// Use the package's exported "./proxy-bridge" subpath (the package "exports"
// map intentionally does not expose package.json, so resolve it that way).
await import('@rapid/llm-proxy/proxy-bridge');
