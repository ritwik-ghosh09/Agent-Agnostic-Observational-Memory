/**
 * Token-budgeted markdown assembly for retrieval results.
 *
 * Uses gpt-tokenizer for accurate token counting (D-07).
 * Selects items by walking RRF-sorted results with per-tier reservation/caps
 * (G2), then emits the selected items as a single list ordered by final
 * score/rank — most favoured first (D-05, D-08).
 *
 * @module token-budget
 */

import { countTokens } from 'gpt-tokenizer';

/** Tier fill order per D-08: insights first, observations last. */
export const TIER_ORDER = ['insights', 'digests', 'kg_entities', 'observations'];

/**
 * Minimum reserved slots per tier (G2 fix).
 *
 * Without this, the lowest-weight tier (observations) monopolizes the token
 * budget: observations appear in semantic + keyword + recency lists and their
 * summary_preview text wins topic-overlap boosts, so they accumulate the highest
 * RRF scores and a pure global budget-walk emits *only* `## Observations` even
 * though higher-weight insights/digests cleared the similarity threshold and are
 * present in the fused set. Reserving at least one slot per non-empty tier (walked
 * in decreasing-weight TIER_ORDER) guarantees the intended
 * Insights > Digests > Entities > Observations blend actually reaches the agent.
 */
const MIN_TIER_SLOTS = 1;

/**
 * Max results per tier to prevent low-precision flooding.
 * MiniLM-L6-v2 cosine similarities cluster high (0.75-0.82) across all
 * project documents, so the Qdrant threshold alone cannot filter irrelevant
 * results. Per-tier caps ensure budget is shared across tiers.
 */
const TIER_MAX_RESULTS = {
  insights: 4,
  digests: 3,
  kg_entities: 3,
  observations: 3,
};

/** Compact per-item tier tag, preserved when items are emitted in rank order. */
const TIER_TAG = {
  insights: 'Insight',
  digests: 'Digest',
  kg_entities: 'Entity',
  observations: 'Observation',
};

/**
 * Format a single result as a markdown block with source attribution.
 *
 * Payload fields are tier-specific (from backfill.ts payload schemas):
 *   insights: { topic, confidence, summary_preview }
 *   digests: { date, theme, agents, quality, summary_preview }
 *   kg_entities: { entityType, hierarchyLevel, summary_preview }
 *   observations: { agent, project, date, quality, summary_preview }
 *
 * @param {object} item - Result item with tier and payload
 * @returns {string} Formatted markdown block
 */
export function formatResult(item) {
  const p = item.payload || {};
  switch (item.tier) {
    case 'insights':
      return `**${p.topic || 'Insight'}** (confidence: ${p.confidence ?? '?'})\n${p.summary_preview || ''}\n`;
    case 'digests':
      return `**${p.theme || 'Digest'}** (${p.date || ''}, agents: ${p.agents || '?'})\n${p.summary_preview || ''}\n`;
    case 'kg_entities':
      return `**${p.entityType || 'Entity'}** (level: ${p.hierarchyLevel || '?'})\n${p.summary_preview || ''}\n`;
    case 'observations':
    default:
      return `*${p.agent || 'agent'}* (${p.date || ''}, ${p.project || ''})\n${p.summary_preview || ''}\n`;
  }
}

/**
 * Truncate summary_preview in a result so the formatted output fits within tokenBudget.
 *
 * Creates the header (formatResult with empty summary_preview), counts its tokens,
 * computes available tokens for preview, slices summary_preview to fit (D-09).
 * Returns null if no space available for content.
 *
 * @param {object} item - Result item with tier and payload
 * @param {number} tokenBudget - Maximum tokens for this result
 * @returns {object|null} New item with truncated payload, or null if no space
 */
export function truncateResult(item, tokenBudget) {
  const headerItem = { ...item, payload: { ...item.payload, summary_preview: '' } };
  const header = formatResult(headerItem);
  const headerTokens = countTokens(header);
  const available = tokenBudget - headerTokens - 5; // 5-token safety margin
  if (available <= 0) return null;

  const preview = item.payload?.summary_preview || '';
  // Approximate: ~4 chars per token, then verify and trim if needed
  let truncated = preview.slice(0, available * 4);
  const truncatedItem = { ...item, payload: { ...item.payload, summary_preview: truncated } };
  const formatted = formatResult(truncatedItem);
  let tokens = countTokens(formatted);

  // If still over budget, binary-reduce
  while (tokens > tokenBudget && truncated.length > 10) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.8));
    truncatedItem.payload = { ...item.payload, summary_preview: truncated };
    tokens = countTokens(formatResult(truncatedItem));
  }

  if (tokens > tokenBudget) return null;
  return { ...item, payload: { ...item.payload, summary_preview: truncated } };
}

/**
 * Assemble token-budgeted markdown from a fused, sorted result list.
 *
 * Walk sorted results (already sorted by RRF score). For each result:
 * format it, count tokens. If adding would exceed budget: truncate to
 * fit remaining (if remaining > 50 tokens), then break. Per-tier reservation
 * (G2) + caps decide WHICH results are included; the selected results are then
 * emitted as a single list ordered by final score/rank — most favoured first,
 * each prefixed with a compact tier tag (D-05, D-08).
 *
 * @param {Array<object>} sortedResults - RRF-fused results sorted by score descending
 * @param {number} budget - Token budget (default 1000 per D-08)
 * @returns {{ markdown: string, tokensUsed: number, includedKeys: string[] }}
 *   `includedKeys` lists the `${tier}:${id}` of every ranked item actually
 *   emitted into the Observational Memory markdown (provenance for the "OM"
 *   indicator in the dashboard). Keyed by tier:id to match the UI item key and
 *   avoid cross-tier id collisions.
 */
/**
 * Compute a content fingerprint for dedup.
 *
 * Insights/digests with near-identical summaries (e.g. "OKB Architecture"
 * vs "Operational Knowledge Base (OKB) Architecture") were appearing as
 * separate results because their topic strings differed slightly. We
 * dedup on the first ~120 chars of the summary preview, lowercased and
 * stripped of non-alphanumerics, which collapses these duplicates.
 *
 * @param {object} item - Result item with tier and payload
 * @returns {string|null} Fingerprint string, or null if unfingerprintable
 */
function contentSignature(item) {
  const p = item.payload || {};
  const preview = (p.summary_preview || p.text || p.content || '').toLowerCase();
  if (!preview) return null;
  const normalized = preview.replace(/[^a-z0-9]/g, '').slice(0, 120);
  if (normalized.length < 20) return null;
  return `${item.tier}:${normalized}`;
}

export function assembleBudgetedMarkdown(sortedResults, budget = 1000) {
  let tokensUsed = 0;

  const tierCounts = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
  const seenSignatures = new Set();
  const includedIds = new Set();
  // Provenance: `${tier}:${id}` of every item emitted into the markdown. Recorded
  // inside tryAdd so the final truncated-on-break item is captured too. Used to
  // mark rankedResults.usedInObservational for the dashboard "OM" pill.
  const includedKeys = new Set();
  // Selected items, each tagged with its final rank so the OM markdown can be
  // emitted in descending score order (most favoured first) regardless of tier.
  const included = [];

  // Final rank lookup: position in the rrfScore-desc `sortedResults` (lower is
  // more favoured). Keyed by `${tier}:${id}` to match the dashboard item key.
  const rankByKey = new Map();
  sortedResults.forEach((r, i) => {
    if (r && r.tier != null && r.id != null) {
      const k = `${r.tier}:${r.id}`;
      if (!rankByKey.has(k)) rankByKey.set(k, i);
    }
  });
  const rankOf = (result) => {
    if (result && result.tier != null && result.id != null) {
      const k = `${result.tier}:${result.id}`;
      if (rankByKey.has(k)) return rankByKey.get(k);
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const recordKey = (result) => {
    if (result == null || result.tier == null || result.id == null) return;
    includedKeys.add(`${result.tier}:${result.id}`);
  };

  // Helper: attempt to add a single result. Returns true if the result was added
  // (in full or truncated), false if skipped/over budget. Selection only — the
  // emission order is decided later by final rank.
  const tryAdd = (result, { allowTruncate }) => {
    if (!(result.tier in tierCounts)) return false;
    const cap = TIER_MAX_RESULTS[result.tier] ?? 5;
    if ((tierCounts[result.tier] ?? 0) >= cap) return false;

    const sig = contentSignature(result);
    if (sig && seenSignatures.has(sig)) return false;

    const formatted = formatResult(result);
    const tokens = countTokens(formatted);

    if (tokensUsed + tokens > budget) {
      if (!allowTruncate) return false;
      const remaining = budget - tokensUsed;
      if (remaining <= 50) return false;
      const truncated = truncateResult(result, remaining);
      if (!truncated) return false;
      const tf = formatResult(truncated);
      included.push({ rank: rankOf(result), tier: result.tier, formatted: tf });
      tierCounts[result.tier] += 1;
      if (sig) seenSignatures.add(sig);
      tokensUsed += countTokens(tf);
      recordKey(result);
      return true;
    }

    included.push({ rank: rankOf(result), tier: result.tier, formatted });
    tierCounts[result.tier] += 1;
    if (sig) seenSignatures.add(sig);
    tokensUsed += tokens;
    recordKey(result);
    return true;
  };

  // Pass 1 (G2 fix): reserve MIN_TIER_SLOTS for each non-empty tier, walked in
  // decreasing-weight TIER_ORDER. This guarantees higher-weight tiers
  // (insights/digests) that cleared the similarity threshold are represented
  // even when lower-weight observations dominate the global RRF ranking. (This
  // controls SELECTION only; the reserved item is still emitted at its true rank.)
  for (const tier of TIER_ORDER) {
    const tierResults = sortedResults.filter((r) => r.tier === tier);
    let reserved = 0;
    for (const result of tierResults) {
      if (reserved >= MIN_TIER_SLOTS) break;
      if (includedIds.has(result.id)) continue;
      if (tryAdd(result, { allowTruncate: true })) {
        includedIds.add(result.id);
        reserved += 1;
      }
    }
  }

  // Pass 2: greedy fill of remaining budget in RRF-sorted order.
  for (const result of sortedResults) {
    if (result.id != null && includedIds.has(result.id)) continue;
    const formatted = formatResult(result);
    const tokens = countTokens(formatted);
    if (tokensUsed + tokens > budget) {
      tryAdd(result, { allowTruncate: true });
      break;
    }
    if (tryAdd(result, { allowTruncate: false }) && result.id != null) {
      includedIds.add(result.id);
    }
  }

  // Emit the selected items in final score/rank order — most favoured first —
  // each prefixed with a compact tier tag so tier attribution survives.
  included.sort((a, b) => a.rank - b.rank);
  const body = included
    .map((e) => `**[${TIER_TAG[e.tier] || 'Item'}]** ${e.formatted}`)
    .join('\n');
  const markdown = body ? `## Observational Memory\n\n${body}` : '';

  return { markdown, tokensUsed, includedKeys: [...includedKeys] };
}
