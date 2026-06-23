/**
 * Unit tests for the shared retrieval query-builder (G1 / G3 parity).
 *
 * Covers prompt-priority budgeting: the user's prompt must be preserved up to
 * MAX_QUERY_CHARS first, with appended `[context: …]` only filling leftover
 * space — never crowding out the user's own words.
 */

import {
  MAX_QUERY_CHARS,
  MIN_WORDS,
  isSubstantivePrompt,
  buildRetrievalQuery,
} from '../../src/hooks/query-builder.js';

describe('isSubstantivePrompt', () => {
  test('rejects empty / whitespace', () => {
    expect(isSubstantivePrompt('')).toBe(false);
    expect(isSubstantivePrompt('   ')).toBe(false);
    expect(isSubstantivePrompt(null)).toBe(false);
    expect(isSubstantivePrompt(undefined)).toBe(false);
  });

  test('rejects slash-commands', () => {
    expect(isSubstantivePrompt('/clear')).toBe(false);
    expect(isSubstantivePrompt('/help me out here please')).toBe(false);
  });

  test('rejects prompts shorter than MIN_WORDS', () => {
    const tooShort = Array(MIN_WORDS - 1).fill('word').join(' ');
    expect(isSubstantivePrompt(tooShort)).toBe(false);
  });

  test('accepts prompts at / above MIN_WORDS', () => {
    const atMin = Array(MIN_WORDS).fill('word').join(' ');
    expect(isSubstantivePrompt(atMin)).toBe(true);
    expect(isSubstantivePrompt('how does the retrieval pipeline rank tiers')).toBe(true);
  });
});

describe('buildRetrievalQuery — prompt-priority budgeting (G1)', () => {
  test('returns bare prompt when no context supplied', () => {
    const prompt = 'how does the knowledge injection hook work';
    expect(buildRetrievalQuery(prompt)).toBe(prompt);
    expect(buildRetrievalQuery(prompt, '')).toBe(prompt);
    expect(buildRetrievalQuery(prompt, '   ')).toBe(prompt);
  });

  test('appends context for a short prompt with room to spare', () => {
    const prompt = 'explain the observational memory tiers';
    const q = buildRetrievalQuery(prompt, 'working memory and digests context');
    expect(q.startsWith(prompt)).toBe(true);
    expect(q).toContain('[context: ');
    expect(q.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
  });

  test('never exceeds MAX_QUERY_CHARS even with huge context', () => {
    const prompt = 'short but valid prompt here';
    const q = buildRetrievalQuery(prompt, 'x'.repeat(5000));
    expect(q.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(q.startsWith(prompt)).toBe(true);
  });

  test('preserves the full prompt up to the cap; drops context when no room', () => {
    // 599-char prompt (>500): context must be omitted, prompt sliced to cap.
    const longPrompt = 'word '.repeat(120).trim();
    expect(longPrompt.length).toBeGreaterThan(MAX_QUERY_CHARS);
    const q = buildRetrievalQuery(longPrompt, 'some conversation context');
    expect(q.length).toBe(MAX_QUERY_CHARS);
    expect(q).not.toContain('[context:');
    // The query is a pure prefix of the user's prompt — no words crowded out.
    expect(longPrompt.startsWith(q)).toBe(true);
  });

  test('omits context when leftover space is below the minimum budget', () => {
    // Prompt just under the cap leaves <20 chars leftover → context dropped.
    const prompt = 'a'.repeat(MAX_QUERY_CHARS - 10);
    const q = buildRetrievalQuery(prompt, 'context that will not fit');
    expect(q).toBe(prompt);
    expect(q).not.toContain('[context:');
  });

  test('handles null / undefined prompt gracefully', () => {
    expect(buildRetrievalQuery(null, 'ctx')).toBe('');
    expect(buildRetrievalQuery(undefined)).toBe('');
  });
});
