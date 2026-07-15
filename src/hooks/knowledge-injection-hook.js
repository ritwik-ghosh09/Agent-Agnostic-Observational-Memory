#!/usr/bin/env node

/**
 * Knowledge Injection Hook for Claude Code (UserPromptSubmit)
 *
 * Calls the retrieval service on substantive prompts and injects
 * returned knowledge as system-reminder context via additionalContext.
 *
 * Conversation-aware: reads the last N assistant messages from the
 * session transcript to build a topic-enriched query, so the retrieval
 * service can discriminate relevant knowledge from project-wide noise.
 *
 * Fail-open: any error or timeout exits 0 with no stdout.
 * Uses shared retrieval-client.js for HTTP calls.
 */

import http from 'node:http';
import { callRetrieval } from './retrieval-client.js';
import {
  isSubstantivePrompt,
  extractConversationTopics,
  buildRetrievalQuery,
} from './query-builder.js';

// Absolute safety ceiling -- never let the hook hang Claude Code
const SAFETY_TIMEOUT_MS = 5000;
const safetyTimer = setTimeout(() => process.exit(0), SAFETY_TIMEOUT_MS);
safetyTimer.unref();

/**
 * Record the genuinely-submitted prompt into the dashboard "Recent Queries"
 * log. This runs on the real UserPromptSubmit event (Claude Code invokes this
 * hook only when the user actually sends a prompt), so — unlike the tmux draft
 * monitor — it never logs typed-but-unsent drafts. Fire-and-forget, fail-open.
 *
 * @param {string} prompt   the submitted prompt text
 * @param {object} context  { project, cwd, agent }
 * @param {string} sessionId  agent session id (optional)
 * @returns {Promise<void>} resolves regardless of outcome
 */
function recordSubmitted(prompt, context, sessionId) {
  return new Promise((resolve) => {
    let base;
    try {
      base = new URL(process.env.LIVE_CONTEXT_URL || 'http://127.0.0.1:3033');
    } catch {
      resolve();
      return;
    }
    let body;
    try {
      body = JSON.stringify({
        query: prompt.slice(0, 500),
        agent: context.agent || 'claude',
        sessionId: sessionId || null,
        project: context.project || null,
        ts: new Date().toISOString(),
      });
    } catch {
      resolve();
      return;
    }
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: '/api/live-context/submitted',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 1500,
      },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

const MAX_OUTPUT_CHARS = 9500;

async function main() {
  try {
    // 1. Read stdin (Claude Code pipes JSON to hook process)
    const chunks = [];
    if (!process.stdin.isTTY) {
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return;

    // 2. Parse input JSON
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return; // Fail-open on parse error
    }

    const prompt = (input.prompt || '').trim();

    // 3-5. Filter: empty / slash-command / short prompts (shared rule)
    if (!isSubstantivePrompt(prompt)) return;

    // 6. Build project context for relevance boosting (D-10)
    const context = {
      project: process.env.CODING_PROJECT_DIR
        ? process.env.CODING_PROJECT_DIR.split('/').pop()
        : process.cwd().split('/').pop(),
      cwd: process.env.CODING_PROJECT_DIR || process.cwd(),
      agent: 'claude',
    };

    // 6b. Record this genuine submission into the dashboard "Recent Queries"
    //     log. UserPromptSubmit fires only on a real send, so this replaces the
    //     unreliable tmux box-clear heuristic. Fire-and-forget, fail-open.
    recordSubmitted(prompt, context, input.session_id);

    // 7-9. Build the retrieval query via the shared query-builder so the tmux
    //      live-draft path (live-query-monitor) produces an identical query and
    //      the dashboard "Live Context" preview matches what gets injected.
    //      Prompt-priority budgeting keeps the user's prompt intact within the
    //      500-char cap; appended [context: …] only fills leftover space (G1).
    const conversationContext = extractConversationTopics(input.transcript_path);
    const query = buildRetrievalQuery(prompt, conversationContext);

    // 10. Call retrieval service with the actual submitted query + context.
    //     We intentionally do NOT pass a threshold here. The query↔item and
    //     query↔query thresholds (and their exponential reshaping) are owned by
    //     the user-tunable GLOBAL retrieval settings, which retrieve() reads as
    //     the single source of truth (src/retrieval/retrieval-settings.js). This
    //     guarantees the UserPromptSubmit path and the dashboard live preview
    //     score identically and honor the user's live slider/toggle changes.
    //     (Default query↔item threshold is 0.70 — MiniLM-L6-v2 same-project
    //     cosine similarities cluster at 0.75-0.82, so a higher floor silently
    //     filtered out legitimate insights/digests; topic-relevance does the
    //     actual ranking, the threshold just admits candidates.)
    const result = await callRetrieval({
      query,
      budget: 1000,
      context,
    });
    if (!result || !result.markdown || result.meta?.results_count === 0) return;

    // 11. Safety truncation (stay under 10K char hook output limit)
    let markdown = result.markdown;
    if (markdown.length > MAX_OUTPUT_CHARS) {
      markdown = markdown.slice(0, MAX_OUTPUT_CHARS) + '\n\n[truncated]';
    }

    // 12. Write JSON to stdout for Claude Code context injection
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: markdown,
      },
    }));
  } catch (err) {
    process.stderr.write('[knowledge-hook] Error: ' + err.message + '\n');
  }
}

main().then(() => process.exit(0));
