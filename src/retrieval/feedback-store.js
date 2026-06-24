/**
 * FeedbackStore -- retrieval-time index over human re-ranking feedback events.
 *
 * Implements the learned rerank boost described in the approved design doc
 * "Feedback Loop Design: Human Re-Ranking as Learned Path-A Boost" (Option A).
 * For an incoming query vector it finds previously-captured rerank events whose
 * query embedding is cosine-similar, then converts the per-item rank deltas of
 * those events into a bounded, signed, confidence-weighted multiplier applied to
 * the matching candidates already present in the fused retrieval list.
 *
 * Design guarantees:
 * - Fail-open: any Qdrant error or a missing/empty collection yields `[]` and a
 *   strict no-op multiplier of 1.0 — identical to current behavior.
 * - Pure aggregation: `aggregateLearnedSignals()` has no I/O so it is unit
 *   testable without Qdrant and is time-injectable for decay testing.
 *
 * @module feedback-store
 */

/* ------------------------------------------------------------------------- *
 * Tuning constants. All are env-overridable so the loop can be tuned without
 * code changes. Defaults are the design's recommended starting values; the
 * human authorized starting from these.
 * ------------------------------------------------------------------------- */

/** Qdrant collection holding one point per human rerank event (384-dim Cosine). */
export const FEEDBACK_COLLECTION = 'human_rerank_feedback';

/** Cosine similarity floor for a feedback event to influence a query (design §3). */
export const SIMILARITY_THRESHOLD = numEnv('LEARNED_RERANK_THRESHOLD', 0.85);

/** Max feedback events fetched per query (design §3). */
export const TOP_K = intEnv('LEARNED_RERANK_TOPK', 10);

/** Exponential decay half-life in days: ageWeight = 0.5 ^ (ageDays / HALF_LIFE) (design §4). */
export const HALF_LIFE_DAYS = numEnv('LEARNED_RERANK_HALF_LIFE_DAYS', 45);

/** Boost coefficient: learnedMultiplier = 1 + COEFFICIENT * learnedSignal (design §2). */
export const BOOST_COEFFICIENT = numEnv('LEARNED_RERANK_COEFFICIENT', 0.30);

/** Hard multiplier bounds — keeps learned rerank below context/topic signals (design §5). */
export const MIN_MULTIPLIER = numEnv('LEARNED_RERANK_MIN_MULTIPLIER', 0.90);
export const MAX_MULTIPLIER = numEnv('LEARNED_RERANK_MAX_MULTIPLIER', 1.25);

/** confidence = min(1, sum(abs(eventWeight)) / DIVISOR) (design §2). */
export const CONFIDENCE_DIVISOR = numEnv('LEARNED_RERANK_CONFIDENCE_DIVISOR', 1.5);

/** learnedSignal is clamped to +/- this magnitude before the multiplier is formed. */
export const SIGNAL_CLAMP = 1.0;

/**
 * Default exponent for the query↔query similarity reshape (similarityWeight =
 * score^EXPONENT). Higher = sharper falloff so only near-duplicate queries carry
 * meaningful weight. Overridden per-call via the runtime retrieval settings.
 */
export const SIMILARITY_EXPONENT = numEnv('LEARNED_RERANK_SIMILARITY_EXPONENT', 3.0);

/**
 * Whether the exponential similarity reshape is applied by default. When false
 * the raw cosine score is used as the weight (linear). Overridden per-call via
 * the runtime retrieval settings.
 */
export const EXPONENTIAL_ENABLED_DEFAULT = (() => {
  const raw = process.env.LEARNED_RERANK_EXPONENTIAL_ENABLED;
  if (raw == null || raw === '') return true;
  return raw === '1' || raw.toLowerCase() === 'true';
})();

/** Default per-user trust weight (design §2; per-user trust model is future work). */
export const DEFAULT_USER_WEIGHT = 1.0;

/** Global (cross-project) fallback is OFF unless LEARNED_RERANK_GLOBAL=1 (design §5). */
export const GLOBAL_SCOPE_ENABLED = String(process.env.LEARNED_RERANK_GLOBAL || '') === '1';

/** Reduced scope weight applied to approved global-fallback events (design §5). */
export const GLOBAL_SCOPE_WEIGHT = numEnv('LEARNED_RERANK_GLOBAL_WEIGHT', 0.5);

/** Higher threshold for the riskier global fallback search (design §5). */
export const GLOBAL_THRESHOLD = numEnv('LEARNED_RERANK_GLOBAL_THRESHOLD', 0.90);

/** Only consult global feedback when project matches are sparser than this (design §5). */
export const GLOBAL_MIN_PROJECT_MATCHES = intEnv('LEARNED_RERANK_GLOBAL_MIN_PROJECT', 2);

/** Guards the weighted-average denominator against divide-by-zero. */
const EPSILON = 1e-9;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) ? v : fallback;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Aggregate matched feedback events into per-itemKey learned multipliers.
 *
 * Pure and deterministic (time injected via `nowMs`) so it can be unit-tested
 * without Qdrant. Implements the design §2 / §4 math:
 *
 *   similarityWeight = exponentialEnabled ? clamp(score,0,1) ^ exponent : score
 *   ageWeight    = 0.5 ^ (ageDays / HALF_LIFE_DAYS)
 *   eventWeight  = similarityWeight * ageWeight * scopeWeight * userWeight
 *   deltaNorm    = (originalRank - humanRank) / max(windowSize - 1, 1)
 *   weightedDelta= sum(deltaNorm * eventWeight) / max(sum(eventWeight), epsilon)
 *   confidence   = min(1, sum(abs(eventWeight)) / CONFIDENCE_DIVISOR)
 *   learnedSignal= clamp(weightedDelta * confidence, -1, 1)
 *   multiplier   = clamp(1 + COEFFICIENT * learnedSignal, MIN, MAX)
 *
 * The similarityWeight reshape concentrates influence on near-duplicate queries:
 * with the exponential enabled a query whose cosine to a past feedback query is
 * only marginally above the admission floor contributes very little, while a
 * near-duplicate (cosine→1) carries full weight. Disabled ⇒ linear (raw cosine).
 *
 * Only itemKeys present in `fusedItemKeys` produce an entry — missing-candidate
 * recall is deliberately out of scope (design §3).
 *
 * @param {Array<{ score: number, scopeWeight?: number, userWeight?: number, payload: object }>} matchedEvents
 * @param {Set<string>|Iterable<string>} fusedItemKeys - stable `tier:id` keys in the current fused list
 * @param {number} [nowMs=Date.now()] - injected clock for deterministic decay
 * @param {object} [opts] - runtime overrides from retrieval settings
 * @param {boolean} [opts.exponentialEnabled=EXPONENTIAL_ENABLED_DEFAULT] - reshape score^exponent
 * @param {number} [opts.exponent=SIMILARITY_EXPONENT] - exponent k when enabled
 * @returns {Map<string, { multiplier: number, signal: number, weightedDelta: number, confidence: number, matchedEvents: number }>}
 */
export function aggregateLearnedSignals(matchedEvents, fusedItemKeys, nowMs = Date.now(), opts = {}) {
  const out = new Map();
  if (!Array.isArray(matchedEvents) || matchedEvents.length === 0) return out;

  const fusedSet = fusedItemKeys instanceof Set ? fusedItemKeys : new Set(fusedItemKeys || []);
  if (fusedSet.size === 0) return out;

  const exponentialEnabled =
    typeof opts.exponentialEnabled === 'boolean' ? opts.exponentialEnabled : EXPONENTIAL_ENABLED_DEFAULT;
  const exponent = Number.isFinite(Number(opts.exponent)) ? Number(opts.exponent) : SIMILARITY_EXPONENT;

  // itemKey -> running accumulators
  const acc = new Map();

  for (const event of matchedEvents) {
    if (!event || typeof event !== 'object') continue;
    const payload = event.payload || {};
    const signals = Array.isArray(payload.itemSignals) ? payload.itemSignals : [];
    if (signals.length === 0) continue;

    const rawScore = Number(event.score);
    if (!Number.isFinite(rawScore) || rawScore <= 0) continue;
    // Query↔query similarity reshape (linear unless the exponential is enabled).
    const similarityWeight = exponentialEnabled
      ? Math.pow(clamp(rawScore, 0, 1), exponent)
      : rawScore;
    if (!Number.isFinite(similarityWeight) || similarityWeight <= 0) continue;

    const scopeWeight = Number.isFinite(Number(event.scopeWeight)) ? Number(event.scopeWeight) : 1.0;
    const userWeight = Number.isFinite(Number(event.userWeight)) ? Number(event.userWeight) : DEFAULT_USER_WEIGHT;
    const ageWeight = computeAgeWeight(payload.capturedAt, nowMs);
    const eventWeight = similarityWeight * ageWeight * scopeWeight * userWeight;
    if (!Number.isFinite(eventWeight) || eventWeight <= 0) continue;

    // windowSize = size of THIS event's ranking (number of item signals it carried).
    const windowSize = signals.length;
    const denom = Math.max(windowSize - 1, 1);

    for (const sig of signals) {
      if (!sig || typeof sig !== 'object') continue;
      const itemKey = typeof sig.itemKey === 'string' ? sig.itemKey : null;
      // Apply only to stable items present in the current fused list (design §3, §5).
      if (!itemKey || !fusedSet.has(itemKey)) continue;

      const originalRank = Number(sig.originalRank);
      const humanRank = Number(sig.humanRank);
      if (!Number.isFinite(originalRank) || !Number.isFinite(humanRank)) continue;

      const deltaNorm = clamp((originalRank - humanRank) / denom, -1, 1);

      let entry = acc.get(itemKey);
      if (!entry) {
        entry = { sumWeightedDelta: 0, sumWeight: 0, sumAbsWeight: 0, events: 0 };
        acc.set(itemKey, entry);
      }
      entry.sumWeightedDelta += deltaNorm * eventWeight;
      entry.sumWeight += eventWeight;
      entry.sumAbsWeight += Math.abs(eventWeight);
      entry.events += 1;
    }
  }

  for (const [itemKey, entry] of acc) {
    const weightedDelta = entry.sumWeightedDelta / Math.max(entry.sumWeight, EPSILON);
    const confidence = Math.min(1.0, entry.sumAbsWeight / CONFIDENCE_DIVISOR);
    const signal = clamp(weightedDelta * confidence, -SIGNAL_CLAMP, SIGNAL_CLAMP);
    const multiplier = clamp(1 + BOOST_COEFFICIENT * signal, MIN_MULTIPLIER, MAX_MULTIPLIER);
    out.set(itemKey, {
      multiplier,
      signal,
      weightedDelta,
      confidence,
      matchedEvents: entry.events,
    });
  }

  return out;
}

/**
 * Exponential half-life decay weight for an event captured at `capturedAt`.
 * Unparseable/future timestamps default to a neutral weight of 1.0.
 *
 * @param {string|number|undefined} capturedAt
 * @param {number} nowMs
 * @returns {number}
 */
function computeAgeWeight(capturedAt, nowMs) {
  if (capturedAt == null) return 1.0;
  const capturedMs = typeof capturedAt === 'number' ? capturedAt : Date.parse(String(capturedAt));
  if (!Number.isFinite(capturedMs)) return 1.0;
  const ageDays = Math.max(0, (nowMs - capturedMs) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/**
 * Vector index over the `human_rerank_feedback` collection.
 *
 * Reuses the RetrievalService Qdrant client; performs no writes. Project-scoped
 * search runs first; an approved, reduced-weight global fallback is consulted
 * only when project matches are sparse and `LEARNED_RERANK_GLOBAL=1`.
 */
export class FeedbackStore {
  /**
   * @param {object} options
   * @param {object} options.qdrantClient - Qdrant REST client (same instance RetrievalService uses)
   * @param {string} [options.collection=FEEDBACK_COLLECTION]
   */
  constructor({ qdrantClient, collection = FEEDBACK_COLLECTION } = {}) {
    this.qdrantClient = qdrantClient || null;
    this.collection = collection;
  }

  /**
   * Find feedback events whose stored query embedding is cosine-similar to
   * `queryVector`. Fail-open: returns `[]` on any error or missing collection.
   *
   * Each returned event carries the cosine `score`, the full `payload`, and a
   * `scopeWeight` (1.0 for same-project, GLOBAL_SCOPE_WEIGHT for global fallback)
   * so the pure aggregator can weight them without re-querying.
   *
   * @param {number[]} queryVector - 384-dim query embedding
   * @param {object|null} context - retrieval context; `context.project` scopes search
   * @param {object} [opts]
   * @param {number} [opts.threshold=SIMILARITY_THRESHOLD]
   * @param {number} [opts.topK=TOP_K]
   * @returns {Promise<Array<{ id: string|number, score: number, scopeWeight: number, payload: object }>>}
   */
  async findSimilar(queryVector, context = null, opts = {}) {
    if (!this.qdrantClient || !Array.isArray(queryVector) || queryVector.length === 0) {
      return [];
    }
    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : SIMILARITY_THRESHOLD;
    const topK = Number.isInteger(opts.topK) ? opts.topK : TOP_K;
    const project = context && typeof context.project === 'string' && context.project.trim()
      ? context.project.trim()
      : null;

    try {
      // Project-scoped search first (design §5).
      const projectFilter = project
        ? { must: [{ key: 'project', match: { value: project } }] }
        : null;

      const projectMatches = await this._search(queryVector, topK, threshold, projectFilter, 1.0);

      const haveEnough = projectMatches.length >= GLOBAL_MIN_PROJECT_MATCHES;
      if (!GLOBAL_SCOPE_ENABLED || !project || haveEnough) {
        return projectMatches;
      }

      // Approved, reduced-weight global fallback only when project matches are sparse.
      const globalThreshold = Math.max(threshold, GLOBAL_THRESHOLD);
      const globalMatches = await this._search(queryVector, topK, globalThreshold, null, GLOBAL_SCOPE_WEIGHT);

      // Merge, preferring the full-weight project match for any duplicate event.
      const byId = new Map();
      for (const m of globalMatches) byId.set(String(m.id), m);
      for (const m of projectMatches) byId.set(String(m.id), m);
      return [...byId.values()];
    } catch (err) {
      // Fail-open: never let a feedback lookup degrade baseline retrieval.
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(`[FeedbackStore] findSimilar failed (non-fatal): ${err.message}\n`);
      }
      return [];
    }
  }

  /**
   * @private
   * @returns {Promise<Array<{ id: string|number, score: number, scopeWeight: number, payload: object }>>}
   */
  async _search(queryVector, topK, threshold, filter, scopeWeight) {
    const params = {
      vector: queryVector,
      limit: topK,
      score_threshold: threshold,
      with_payload: true,
      with_vector: false,
    };
    if (filter) params.filter = filter;
    const points = await this.qdrantClient.search(this.collection, params);
    return (points || []).map((p) => ({
      id: p.id,
      score: p.score,
      scopeWeight,
      payload: p.payload || {},
    }));
  }
}

export default FeedbackStore;
