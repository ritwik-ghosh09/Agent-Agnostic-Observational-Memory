/**
 * Retrieval scoring settings — persisted, user-tunable knobs for the two
 * similarity stages that drive retrieval ranking:
 *
 *   queryQuery — learned-rerank feedback gate. How strongly a past human-ranked
 *                query influences the current query's ranking, gated by the
 *                query↔query cosine similarity.
 *   queryItem  — semantic retrieval. Which memory items are admitted for the
 *                current query (query↔item cosine) and how steeply their
 *                similarity is emphasised.
 *
 * Each stage exposes:
 *   threshold          — cosine admission floor (Qdrant score_threshold).
 *   exponentialEnabled — when true the similarity is reshaped as score^exponent
 *                        (sharper emphasis on near matches); when false the raw
 *                        cosine is used (linear).
 *   exponent           — the exponent k used when exponentialEnabled.
 *
 * Persistence: a single JSON file under the observations data dir. The store is
 * the SINGLE SOURCE OF TRUTH read by retrieve(), so BOTH the UserPromptSubmit
 * hook (Path A) and the dashboard live preview honour the same values.
 *
 * Fail-open: any read/parse error falls back to env-seeded defaults. Writes are
 * atomic (tmp file + rename). Zero npm dependencies — node built-ins only.
 *
 * @module retrieval-settings
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root = two levels up from src/retrieval/. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Settings file location (override with RETRIEVAL_SETTINGS_PATH). */
export const SETTINGS_PATH =
  process.env.RETRIEVAL_SETTINGS_PATH ||
  path.join(REPO_ROOT, '.observations', 'retrieval-settings.json');

/* --------------------------------------------------------------------------- *
 * Validation bounds (shared with the API layer).
 * --------------------------------------------------------------------------- */
export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.99;
export const EXPONENT_MIN = 1.0;
export const EXPONENT_MAX = 8.0;

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** Env-seeded defaults. Mirrors the historical hard-coded values. */
export function defaultSettings() {
  return {
    queryQuery: {
      threshold: numEnv('LEARNED_RERANK_THRESHOLD', 0.85),
      exponentialEnabled: boolEnv('LEARNED_RERANK_EXPONENTIAL_ENABLED', true),
      exponent: numEnv('LEARNED_RERANK_SIMILARITY_EXPONENT', 3.0),
    },
    queryItem: {
      threshold: numEnv('RETRIEVAL_SCORE_THRESHOLD', 0.7),
      exponentialEnabled: boolEnv('RETRIEVAL_ITEM_EXPONENTIAL_ENABLED', false),
      exponent: numEnv('RETRIEVAL_ITEM_SIMILARITY_EXPONENT', 3.0),
    },
  };
}

/**
 * Coerce + clamp one stage object to valid bounds, filling gaps from defaults.
 *
 * @param {object} raw - candidate stage settings (may be partial/garbage)
 * @param {object} fallback - the default stage to fill missing fields
 * @returns {{ threshold: number, exponentialEnabled: boolean, exponent: number }}
 */
function sanitizeStage(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const threshold = Number.isFinite(Number(src.threshold))
    ? clamp(Number(src.threshold), THRESHOLD_MIN, THRESHOLD_MAX)
    : fallback.threshold;
  const exponent = Number.isFinite(Number(src.exponent))
    ? clamp(Number(src.exponent), EXPONENT_MIN, EXPONENT_MAX)
    : fallback.exponent;
  const exponentialEnabled =
    typeof src.exponentialEnabled === 'boolean'
      ? src.exponentialEnabled
      : fallback.exponentialEnabled;
  return { threshold, exponentialEnabled, exponent };
}

/**
 * Validate + normalise a full settings object against bounds and defaults.
 *
 * @param {object} raw
 * @returns {{ queryQuery: object, queryItem: object }}
 */
export function sanitizeSettings(raw) {
  const d = defaultSettings();
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    queryQuery: sanitizeStage(src.queryQuery, d.queryQuery),
    queryItem: sanitizeStage(src.queryItem, d.queryItem),
  };
}

/* --------------------------------------------------------------------------- *
 * In-memory cache with mtime-based reload so concurrent writers (the PUT
 * endpoint) and readers (retrieve()) stay consistent without re-reading the
 * file on every retrieval.
 * --------------------------------------------------------------------------- */
let _cache = null;
let _cacheMtimeMs = 0;

/**
 * Get the current effective settings (validated). Reloads from disk only when
 * the file's mtime changed since the last read. Fail-open to defaults.
 *
 * @returns {{ queryQuery: object, queryItem: object }}
 */
export function getSettings() {
  try {
    const stat = fs.statSync(SETTINGS_PATH);
    if (_cache && stat.mtimeMs === _cacheMtimeMs) return _cache;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    _cache = sanitizeSettings(raw);
    _cacheMtimeMs = stat.mtimeMs;
    return _cache;
  } catch {
    // Missing file or parse error: serve (and cache) defaults.
    if (!_cache) _cache = defaultSettings();
    return _cache;
  }
}

/**
 * Persist a (possibly partial) settings update. Merges over current settings,
 * validates, atomically writes the file, refreshes the cache, and returns the
 * stored value.
 *
 * @param {object} partial - { queryQuery?: {...}, queryItem?: {...} }
 * @returns {{ queryQuery: object, queryItem: object }}
 */
export function updateSettings(partial) {
  const current = getSettings();
  const src = partial && typeof partial === 'object' ? partial : {};
  const merged = {
    queryQuery: { ...current.queryQuery, ...(src.queryQuery || {}) },
    queryItem: { ...current.queryItem, ...(src.queryItem || {}) },
  };
  const next = sanitizeSettings(merged);

  const dir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);

  try {
    _cacheMtimeMs = fs.statSync(SETTINGS_PATH).mtimeMs;
  } catch {
    _cacheMtimeMs = Date.now();
  }
  _cache = next;
  return next;
}
