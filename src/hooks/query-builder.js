/**
 * Shared retrieval query-builder.
 *
 * Single source of truth for turning a raw user prompt into the query string
 * sent to the retrieval service. Used by BOTH the Claude `UserPromptSubmit` hook
 * (Path A) and the tmux live-draft monitor (Path B) so the dashboard "Live
 * Context" preview reflects the exact same query the hook would inject.
 *
 * Responsibilities:
 *  - Optional conversation-context enrichment from the session transcript.
 *  - Prompt-priority budgeting: the user's prompt is preserved up to the cap
 *    FIRST; appended `[context: …]` only fills the *leftover* space. This fixes
 *    the previous behaviour where appending context could push the user's own
 *    words past the 500-char cap and silently drop them (G1).
 *
 * Zero npm dependencies — node built-ins only. Fail-open: enrichment errors
 * degrade to the bare (capped) prompt.
 *
 * @module query-builder
 */

import fs from 'node:fs';

/** Maximum query length accepted by the retrieval server. */
export const MAX_QUERY_CHARS = 500;

/** Minimum words for a substantive prompt (short prompts are skipped). */
export const MIN_WORDS = 4;

/** Read last ~50KB of transcript for topic extraction. */
const TRANSCRIPT_TAIL_BYTES = 50000;

/** Context summary length cap for query enrichment. */
const MAX_CONTEXT_CHARS = 300;

/** Wrapper overhead of the ` [context: …]` envelope. */
const CONTEXT_ENVELOPE = ' [context: ]';

/** Minimum leftover chars worth spending on appended context. */
const MIN_CONTEXT_BUDGET = 20;

/**
 * Decide whether a prompt is substantive enough to retrieve on.
 *
 * @param {string} prompt
 * @returns {boolean}
 */
export function isSubstantivePrompt(prompt) {
  const p = (prompt || '').trim();
  if (!p) return false;
  if (p.startsWith('/')) return false;
  if (p.split(/\s+/).length < MIN_WORDS) return false;
  return true;
}

/**
 * Extract conversation topics from a session transcript JSONL.
 *
 * Reads the tail of the file, collects recent human/assistant text, and skips
 * previously injected system-reminder content to avoid feedback loops.
 *
 * @param {string} transcriptPath - Path to the .jsonl transcript (optional)
 * @returns {string} Topic summary (max MAX_CONTEXT_CHARS chars), '' on any error
 */
export function extractConversationTopics(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';

    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(Math.min(stat.size, TRANSCRIPT_TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const tail = buf.toString('utf8');
    const lines = tail.split('\n');
    if (start > 0) lines.shift();

    const isReminder = (s) =>
      s.includes('<system-reminder>') || s.includes('## Insights') || s.includes('## Digests');

    const snippets = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const extractText = (content) => {
          if (typeof content === 'string') {
            if (isReminder(content)) return null;
            return content.slice(0, 200);
          }
          if (Array.isArray(content)) {
            const parts = [];
            for (const block of content) {
              if (block.type !== 'text' || !block.text) continue;
              if (isReminder(block.text)) continue;
              parts.push(block.text.slice(0, 200));
            }
            return parts.length > 0 ? parts.join(' ') : null;
          }
          return null;
        };
        if (msg.role === 'user' || msg.role === 'assistant') {
          const text = extractText(msg.content);
          if (text) snippets.push(text);
        }
      } catch {
        // skip unparseable lines
      }
    }

    return snippets.slice(-5).join(' ').slice(0, MAX_CONTEXT_CHARS);
  } catch {
    return '';
  }
}

/**
 * Build the final retrieval query from a prompt and optional conversation context.
 *
 * Prompt-priority budgeting (G1): the prompt is preserved up to MAX_QUERY_CHARS
 * first; the `[context: …]` envelope only consumes leftover space. If there is
 * no leftover room, the context is omitted entirely rather than truncating the
 * user's prompt.
 *
 * @param {string} prompt - Raw user prompt
 * @param {string} [conversationContext=''] - Pre-extracted topic context
 * @returns {string} The query string to send to retrieval (≤ MAX_QUERY_CHARS)
 */
export function buildRetrievalQuery(prompt, conversationContext = '') {
  const basePrompt = (prompt || '').trim().slice(0, MAX_QUERY_CHARS);
  if (!basePrompt) return '';
  const ctx = (conversationContext || '').trim();
  if (!ctx) return basePrompt;

  const leftover = MAX_QUERY_CHARS - basePrompt.length - CONTEXT_ENVELOPE.length;
  if (leftover < MIN_CONTEXT_BUDGET) return basePrompt;

  return `${basePrompt} [context: ${ctx.slice(0, leftover)}]`;
}

/**
 * Convenience: build a query directly from a prompt + transcript path.
 *
 * @param {string} prompt
 * @param {string} [transcriptPath]
 * @returns {string}
 */
export function buildQueryFromTranscript(prompt, transcriptPath) {
  return buildRetrievalQuery(prompt, extractConversationTopics(transcriptPath));
}
