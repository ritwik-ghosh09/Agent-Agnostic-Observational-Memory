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

    // 7-9. Build the retrieval query via the shared query-builder so the tmux
    //      live-draft path (live-query-monitor) produces an identical query and
    //      the dashboard "Live Context" preview matches what gets injected.
    //      Prompt-priority budgeting keeps the user's prompt intact within the
    //      500-char cap; appended [context: …] only fills leftover space (G1).
    const conversationContext = extractConversationTopics(input.transcript_path);
    const query = buildRetrievalQuery(prompt, conversationContext);

    // 10. Call retrieval service with context.
    // threshold=0.70: MiniLM-L6-v2 same-project cosine similarities cluster
    // at 0.75-0.82 (see retrieval-service.js _applyTopicRelevance), so a
    // higher floor silently filtered out almost every legitimate insight or
    // digest. The retrieval-service's topic-relevance pass (substring + exact-
    // token overlap) does the actual ranking; the threshold's job is just to
    // let the candidates in.
    const result = await callRetrieval({
      query,
      budget: 1000,
      threshold: 0.70,
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
