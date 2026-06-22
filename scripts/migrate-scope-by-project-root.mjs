#!/usr/bin/env node
/**
 * migrate-scope-by-project-root.mjs — re-scope existing observational memory
 * by project ROOT (codebase identity) instead of the legacy basename label.
 *
 * Two different codebases that share a directory basename (or that fell into
 * the old hardcoded 'coding' bucket) were previously summarized together. This
 * migration:
 *
 *   1. Backfill — re-derive `metadata.projectRoot` (+ basename `project`) for
 *      every observation from its own captured context (file paths matched
 *      against the local repo corpus). Undecidable rows stay an isolated
 *      'unknown' and are never merged with a real root.
 *   2. Archive + reset — copy existing digests and insights into timestamped
 *      backup tables, delete them, and clear observations.digested_at so the
 *      consolidator re-groups every observation from scratch.
 *   3. Regenerate — re-run consolidateAll() + synthesizeInsights(), now
 *      partitioned by project root, so historical digests/insights are
 *      re-scoped per codebase.
 *
 * Regeneration (step 3) makes LLM calls — the summarizer proxy must be up.
 *
 * Usage:
 *   node scripts/migrate-scope-by-project-root.mjs                # dry-run (default)
 *   node scripts/migrate-scope-by-project-root.mjs --execute      # apply
 *   node scripts/migrate-scope-by-project-root.mjs --execute --roots=<absA>,<absB>
 *   node scripts/migrate-scope-by-project-root.mjs --execute --no-regenerate  # backfill+reset only
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObservationConsolidator } from '../src/live-logging/ObservationConsolidator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(REPO_ROOT, '.observations', 'observations.db');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');
const NO_REGENERATE = args.includes('--no-regenerate');
const JSON_OUT = args.includes('--json');

const rootsSelection = [];
for (const a of args) {
  if (a.startsWith('--root=')) rootsSelection.push(a.slice('--root='.length));
  else if (a.startsWith('--roots=')) rootsSelection.push(...a.slice('--roots='.length).split(',').map(s => s.trim()).filter(Boolean));
}
const roots = rootsSelection.length ? rootsSelection : null;

function log(msg) { process.stderr.write(`[migrate-root] ${msg}\n`); }

async function main() {
  const consolidator = new ObservationConsolidator({ dbPath: DB_PATH });
  await consolidator.init();
  const db = consolidator.db;

  const summary = { dryRun: DRY_RUN, backfilled: 0, perRoot: {}, archivedDigests: 0, archivedInsights: 0, regenerate: !NO_REGENERATE };

  try {
    log(DRY_RUN ? 'DRY-RUN (no writes). Pass --execute to apply.' : 'EXECUTE mode — applying changes.');

    // ---- Step 1: backfill metadata.projectRoot + basename project ----
    const observations = db.prepare('SELECT id, metadata FROM observations').all();
    const updateObs = db.prepare(`
      UPDATE observations
      SET metadata = json_set(COALESCE(metadata, '{}'), '$.project', ?, '$.projectRoot', ?)
      WHERE id = ?
    `);
    const backfill = db.transaction((rows) => {
      for (const o of rows) {
        const { key, label } = consolidator._projectKey(o);
        summary.perRoot[key] = summary.perRoot[key] || { project: label, observations: 0 };
        summary.perRoot[key].observations++;
        summary.backfilled++;
        if (!DRY_RUN) updateObs.run(label, key, o.id);
      }
    });
    backfill(observations);
    log(`Backfill: ${summary.backfilled} observation(s) across ${Object.keys(summary.perRoot).length} root(s)`);
    for (const [key, v] of Object.entries(summary.perRoot)) {
      log(`  ${key}  [${v.project}]  obs=${v.observations}`);
    }

    // ---- Step 2: archive + reset digests/insights ----
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const digestCount = db.prepare('SELECT COUNT(*) AS c FROM digests').get().c;
    const insightCount = db.prepare('SELECT COUNT(*) AS c FROM insights').get().c;
    summary.archivedDigests = digestCount;
    summary.archivedInsights = insightCount;

    if (!DRY_RUN) {
      const reset = db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS digests_archive_${ts} AS SELECT * FROM digests`);
        db.exec(`CREATE TABLE IF NOT EXISTS insights_archive_${ts} AS SELECT * FROM insights`);
        db.exec('DELETE FROM insights');
        db.exec('DELETE FROM digests');
        db.exec('UPDATE observations SET digested_at = NULL');
      });
      reset();
      log(`Archived ${digestCount} digest(s) -> digests_archive_${ts}, ${insightCount} insight(s) -> insights_archive_${ts}`);
      log('Cleared digests/insights and reset observations.digested_at');
    } else {
      log(`Would archive ${digestCount} digest(s) + ${insightCount} insight(s) into digests_archive_${ts}/insights_archive_${ts}, then reset.`);
    }

    // ---- Step 3: regenerate per root ----
    if (DRY_RUN) {
      log('Dry-run: skipping regeneration. Re-run with --execute to regenerate.');
    } else if (NO_REGENERATE) {
      log('--no-regenerate: backfill + reset done; run the consolidator separately to regenerate.');
    } else {
      log(`Regenerating digests + insights${roots ? ` for roots: ${roots.join(', ')}` : ' for all roots'} (LLM calls — proxy must be up)…`);
      const result = await consolidator.run({ includeToday: true, roots });
      summary.regenerated = result;
      log(`Regeneration: ${result.digests} digest(s), ${result.created} insight(s) created, ${result.updated} updated`);
    }

    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, ...summary }) + '\n');
    log('Done.');
  } finally {
    consolidator.close();
  }
}

main().catch((err) => {
  log(`FAILED: ${err.stack || err.message}`);
  process.exit(1);
});
