/**
 * Unit tests for token-budgeted markdown assembly (G2 fix).
 *
 * Verifies the per-tier minimum-slot guarantee: higher-weight tiers
 * (insights/digests) that cleared the similarity threshold must be represented
 * in the final markdown even when lower-weight observations dominate the global
 * RRF ranking and would otherwise monopolize the token budget.
 */

import {
  assembleBudgetedMarkdown,
  TIER_ORDER,
} from '../../src/retrieval/token-budget.js';

/** Build a synthetic result for a given tier with a distinct preview. */
function mkResult(id, tier, score, previewSeed) {
  const preview = `${previewSeed} ${'detail '.repeat(20)}`.trim();
  return {
    id,
    tier,
    rrfScore: score,
    payload: {
      topic: `topic-${id}`,
      theme: `theme-${id}`,
      entityType: `entity-${id}`,
      agent: `agent-${id}`,
      confidence: 0.8,
      date: '2026-06-23',
      project: 'obs-memory',
      summary_preview: preview,
    },
  };
}

describe('assembleBudgetedMarkdown — per-tier minimum slots (G2)', () => {
  test('surfaces higher tiers even when observations dominate RRF ordering', () => {
    // Observations sorted to the very top (highest RRF), insights/digests below.
    const sorted = [
      mkResult('o1', 'observations', 0.99, 'observation alpha'),
      mkResult('o2', 'observations', 0.98, 'observation beta'),
      mkResult('o3', 'observations', 0.97, 'observation gamma'),
      mkResult('i1', 'insights', 0.50, 'insight delta'),
      mkResult('d1', 'digests', 0.40, 'digest epsilon'),
    ];

    const { markdown } = assembleBudgetedMarkdown(sorted, 1000);

    expect(markdown).toContain('## Insights');
    expect(markdown).toContain('## Digests');
    expect(markdown).toContain('## Observations');
  });

  test('orders tier sections by decreasing weight (TIER_ORDER)', () => {
    const sorted = [
      mkResult('o1', 'observations', 0.99, 'obs one'),
      mkResult('i1', 'insights', 0.80, 'ins one'),
      mkResult('d1', 'digests', 0.70, 'dig one'),
    ];

    const { markdown } = assembleBudgetedMarkdown(sorted, 1000);
    const idxInsights = markdown.indexOf('## Insights');
    const idxDigests = markdown.indexOf('## Digests');
    const idxObs = markdown.indexOf('## Observations');

    expect(idxInsights).toBeGreaterThanOrEqual(0);
    expect(idxInsights).toBeLessThan(idxDigests);
    expect(idxDigests).toBeLessThan(idxObs);
  });

  test('only emits headers for tiers that have results', () => {
    const sorted = [
      mkResult('i1', 'insights', 0.80, 'only insights here'),
      mkResult('i2', 'insights', 0.70, 'another insight'),
    ];
    const { markdown } = assembleBudgetedMarkdown(sorted, 1000);
    expect(markdown).toContain('## Insights');
    expect(markdown).not.toContain('## Digests');
    expect(markdown).not.toContain('## Observations');
    expect(markdown).not.toContain('## Entities');
  });

  test('respects the token budget', () => {
    const sorted = TIER_ORDER.flatMap((tier, ti) =>
      Array.from({ length: 4 }, (_, i) =>
        mkResult(`${tier}-${i}`, tier, 0.9 - ti * 0.1 - i * 0.01, `${tier} item ${i}`)
      )
    );
    const { tokensUsed } = assembleBudgetedMarkdown(sorted, 300);
    expect(tokensUsed).toBeLessThanOrEqual(300);
  });

  test('empty input yields empty markdown', () => {
    const { markdown, tokensUsed } = assembleBudgetedMarkdown([], 1000);
    expect(markdown).toBe('');
    expect(tokensUsed).toBe(0);
  });

  test('dedups near-identical content within a tier', () => {
    const sorted = [
      mkResult('i1', 'insights', 0.80, 'OKB Architecture overview'),
      // Same normalized preview → should be deduped.
      { ...mkResult('i2', 'insights', 0.79, 'OKB Architecture overview'), id: 'i2' },
    ];
    const { markdown } = assembleBudgetedMarkdown(sorted, 1000);
    const occurrences = (markdown.match(/OKB Architecture overview/g) || []).length;
    expect(occurrences).toBe(1);
  });
});

describe('assembleBudgetedMarkdown — includedKeys provenance (OM pill)', () => {
  test('returns tier:id keys for every emitted item', () => {
    const sorted = [
      mkResult('i1', 'insights', 0.99, 'insight alpha'),
      mkResult('d1', 'digests', 0.80, 'digest beta'),
      mkResult('o1', 'observations', 0.70, 'observation gamma'),
    ];
    const { includedKeys } = assembleBudgetedMarkdown(sorted, 1000);
    expect(includedKeys).toEqual(
      expect.arrayContaining(['insights:i1', 'digests:d1', 'observations:o1'])
    );
    // Keys must use the `tier:id` form (matches the UI item key).
    for (const key of includedKeys) {
      expect(key).toMatch(/^(insights|digests|kg_entities|observations):/);
    }
  });

  test('every includedKey corresponds to content present in the markdown', () => {
    const items = [
      mkResult('i1', 'insights', 0.99, 'insight alpha'),
      mkResult('d1', 'digests', 0.80, 'digest beta'),
      mkResult('o1', 'observations', 0.70, 'observation gamma'),
    ];
    const previewByKey = new Map(items.map((it) => [`${it.tier}:${it.id}`, it.payload.summary_preview]));
    const { markdown, includedKeys } = assembleBudgetedMarkdown(items, 1000);
    for (const key of includedKeys) {
      const preview = previewByKey.get(key);
      expect(preview).toBeTruthy();
      expect(markdown).toContain(preview);
    }
  });

  test('a deduped duplicate is excluded from includedKeys', () => {
    const sorted = [
      mkResult('i1', 'insights', 0.80, 'OKB Architecture overview'),
      // Same normalized preview as i1 → deduped (never emitted).
      { ...mkResult('i2', 'insights', 0.79, 'OKB Architecture overview'), id: 'i2' },
    ];
    const { includedKeys } = assembleBudgetedMarkdown(sorted, 1000);
    expect(includedKeys).toContain('insights:i1');
    expect(includedKeys).not.toContain('insights:i2');
  });

  test('empty input yields empty includedKeys', () => {
    const { includedKeys } = assembleBudgetedMarkdown([], 1000);
    expect(includedKeys).toEqual([]);
  });
});
