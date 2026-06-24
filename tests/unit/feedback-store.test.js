/**
 * Unit tests for the pure learned-rerank aggregation helper (G6).
 *
 * These exercise `aggregateLearnedSignals()` in isolation — no Qdrant, no
 * network — by feeding synthetic matched feedback events and asserting the
 * design's §2/§4 math: promotion boosts, threshold-by-caller exclusion, clamp
 * bounds, time decay, contradiction cancellation, and fused-set filtering.
 */

import {
  aggregateLearnedSignals,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
} from '../../src/retrieval/feedback-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-23T12:00:00.000Z');

/**
 * Build a matched feedback event. `signals` is an array of
 * { itemKey, originalRank, humanRank }; windowSize is derived from its length,
 * so pad with filler items to simulate a wider ranking window.
 */
function mkEvent(signals, { score = 0.9, scopeWeight = 1.0, ageDays = 0, windowSize } = {}) {
  const itemSignals = signals.map((s) => ({
    itemKey: s.itemKey,
    tier: s.itemKey.split(':')[0],
    originalRank: s.originalRank,
    humanRank: s.humanRank,
    rankDelta: s.originalRank - s.humanRank,
  }));
  // Pad with neutral filler so windowSize matches a realistic visible window.
  const targetSize = windowSize ?? itemSignals.length;
  let n = itemSignals.length;
  while (itemSignals.length < targetSize) {
    n += 1;
    itemSignals.push({
      itemKey: `filler:${n}`,
      tier: 'filler',
      originalRank: n,
      humanRank: n,
      rankDelta: 0,
    });
  }
  return {
    score,
    scopeWeight,
    payload: {
      capturedAt: new Date(NOW - ageDays * DAY_MS).toISOString(),
      itemSignals,
    },
  };
}

describe('aggregateLearnedSignals', () => {
  test('(1) empty matches produce no multipliers', () => {
    const out = aggregateLearnedSignals([], new Set(['insights:A']), NOW);
    expect(out.size).toBe(0);
  });

  test('(1b) empty fused set produces no multipliers', () => {
    const ev = mkEvent([{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }], { windowSize: 10 });
    const out = aggregateLearnedSignals([ev], new Set(), NOW);
    expect(out.size).toBe(0);
  });

  test('(2) near-duplicate promotion (rank 5 -> 1) yields multiplier > 1.0', () => {
    const ev = mkEvent([{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }], { windowSize: 10 });
    const out = aggregateLearnedSignals([ev], new Set(['insights:A']), NOW);
    const info = out.get('insights:A');
    expect(info).toBeDefined();
    expect(info.multiplier).toBeGreaterThan(1.0);
    expect(info.signal).toBeGreaterThan(0);
    expect(info.matchedEvents).toBe(1);
  });

  test('(3) only events passed in by the caller have effect', () => {
    // The caller is responsible for the 0.85 threshold filter; an event it does
    // not pass in must not influence the result.
    const passed = mkEvent([{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }], { windowSize: 10 });
    const withOnlyPassed = aggregateLearnedSignals([passed], new Set(['insights:A', 'digests:B']), NOW);
    expect(withOnlyPassed.has('digests:B')).toBe(false); // no event referenced it
    expect(withOnlyPassed.get('insights:A').multiplier).toBeGreaterThan(1.0);
  });

  test('(4) clamp: many identical promotions never exceed MAX, many demotions never below MIN', () => {
    const promote = Array.from({ length: 25 }, () =>
      mkEvent([{ itemKey: 'insights:A', originalRank: 10, humanRank: 1 }], { windowSize: 10 })
    );
    const up = aggregateLearnedSignals(promote, new Set(['insights:A']), NOW);
    expect(up.get('insights:A').multiplier).toBeLessThanOrEqual(MAX_MULTIPLIER);
    expect(up.get('insights:A').multiplier).toBeCloseTo(MAX_MULTIPLIER, 5);

    const demote = Array.from({ length: 25 }, () =>
      mkEvent([{ itemKey: 'insights:A', originalRank: 1, humanRank: 10 }], { windowSize: 10 })
    );
    const down = aggregateLearnedSignals(demote, new Set(['insights:A']), NOW);
    expect(down.get('insights:A').multiplier).toBeGreaterThanOrEqual(MIN_MULTIPLIER);
    expect(down.get('insights:A').multiplier).toBeCloseTo(MIN_MULTIPLIER, 5);
  });

  test('(5) decay: a 90-day-old event has less effect than a fresh one with identical delta', () => {
    const fresh = mkEvent([{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }], { windowSize: 10, ageDays: 0 });
    const stale = mkEvent([{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }], { windowSize: 10, ageDays: 90 });

    const freshOut = aggregateLearnedSignals([fresh], new Set(['insights:A']), NOW);
    const staleOut = aggregateLearnedSignals([stale], new Set(['insights:A']), NOW);

    // Both promote, but the stale event's confidence is lower (smaller eventWeight).
    expect(staleOut.get('insights:A').multiplier).toBeGreaterThan(1.0);
    expect(staleOut.get('insights:A').multiplier).toBeLessThan(freshOut.get('insights:A').multiplier);
  });

  test('(6) contradictory equal-weight promote + demote cancels to multiplier ~= 1.0', () => {
    const promote = mkEvent([{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }], { windowSize: 10 });
    const demote = mkEvent([{ itemKey: 'insights:A', originalRank: 1, humanRank: 5 }], { windowSize: 10 });
    const out = aggregateLearnedSignals([promote, demote], new Set(['insights:A']), NOW);
    expect(out.get('insights:A').multiplier).toBeCloseTo(1.0, 6);
    expect(out.get('insights:A').signal).toBeCloseTo(0, 6);
  });

  test('(7) only itemKeys present in the fused set get boosted', () => {
    const ev = mkEvent(
      [
        { itemKey: 'insights:A', originalRank: 5, humanRank: 1 },
        { itemKey: 'digests:B', originalRank: 6, humanRank: 2 },
      ],
      { windowSize: 10 }
    );
    // Only A is in the current fused list; B must be ignored.
    const out = aggregateLearnedSignals([ev], new Set(['insights:A']), NOW);
    expect(out.has('insights:A')).toBe(true);
    expect(out.has('digests:B')).toBe(false);
  });

  test('(8) unstable/random keyword fallback ids are excluded unless present in fused set', () => {
    const ev = mkEvent(
      [{ itemKey: 'observations:kw-observations-x7f3q9', originalRank: 4, humanRank: 1 }],
      { windowSize: 10 }
    );
    // A future query produces a different random id, so the old key is absent.
    const out = aggregateLearnedSignals([ev], new Set(['observations:stable-123']), NOW);
    expect(out.size).toBe(0);
  });

  test('(9) global-fallback scopeWeight reduces effect vs same-project', () => {
    const project = mkEvent([{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }], { windowSize: 10, scopeWeight: 1.0 });
    const global = mkEvent([{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }], { windowSize: 10, scopeWeight: 0.5 });
    const pOut = aggregateLearnedSignals([project], new Set(['insights:A']), NOW);
    const gOut = aggregateLearnedSignals([global], new Set(['insights:A']), NOW);
    expect(gOut.get('insights:A').multiplier).toBeLessThan(pOut.get('insights:A').multiplier);
    expect(gOut.get('insights:A').multiplier).toBeGreaterThan(1.0);
  });

  // ---- Query↔Query exponential reshape (opts) --------------------------------

  test('(10) exponential OFF uses linear (raw cosine) weighting', () => {
    const sig = [{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }];
    const hi = aggregateLearnedSignals(
      [mkEvent(sig, { windowSize: 10, score: 0.99 })],
      new Set(['insights:A']),
      NOW,
      { exponentialEnabled: false }
    );
    const lo = aggregateLearnedSignals(
      [mkEvent(sig, { windowSize: 10, score: 0.86 })],
      new Set(['insights:A']),
      NOW,
      { exponentialEnabled: false }
    );
    // Linear: higher cosine still gives a (slightly) stronger boost via confidence.
    expect(hi.get('insights:A').multiplier).toBeGreaterThan(lo.get('insights:A').multiplier);
    expect(lo.get('insights:A').multiplier).toBeGreaterThan(1.0);
  });

  test('(11) exponential ON sharpens: monotonic falloff in query similarity', () => {
    const sig = [{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }];
    const mult = (score) =>
      aggregateLearnedSignals(
        [mkEvent(sig, { windowSize: 10, score })],
        new Set(['insights:A']),
        NOW,
        { exponentialEnabled: true, exponent: 3.0 }
      ).get('insights:A').multiplier;
    const m99 = mult(0.99);
    const m90 = mult(0.9);
    const m85 = mult(0.85);
    expect(m99).toBeGreaterThan(m90);
    expect(m90).toBeGreaterThan(m85);
    expect(m99).toBeGreaterThan(1.0);
  });

  test('(12) higher exponent widens the near-duplicate advantage', () => {
    const sig = [{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }];
    const at = (score, exponent) =>
      aggregateLearnedSignals(
        [mkEvent(sig, { windowSize: 10, score })],
        new Set(['insights:A']),
        NOW,
        { exponentialEnabled: true, exponent }
      ).get('insights:A').multiplier;
    // For a sub-1.0 cosine, a larger exponent shrinks the boost (more de-emphasis).
    expect(at(0.9, 5.0)).toBeLessThan(at(0.9, 3.0));
    // A near-duplicate (cos≈1) is barely affected by the exponent.
    expect(at(0.99, 5.0)).toBeGreaterThan(at(0.9, 5.0));
  });

  test('(13) exponential default (no opts) matches exponent 3.0', () => {
    const sig = [{ itemKey: 'insights:A', originalRank: 5, humanRank: 1 }];
    const dflt = aggregateLearnedSignals(
      [mkEvent(sig, { windowSize: 10, score: 0.9 })],
      new Set(['insights:A']),
      NOW
    ).get('insights:A').multiplier;
    const explicit = aggregateLearnedSignals(
      [mkEvent(sig, { windowSize: 10, score: 0.9 })],
      new Set(['insights:A']),
      NOW,
      { exponentialEnabled: true, exponent: 3.0 }
    ).get('insights:A').multiplier;
    expect(dflt).toBeCloseTo(explicit, 10);
  });
});
