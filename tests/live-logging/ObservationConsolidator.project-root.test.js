/**
 * ObservationConsolidator project-root scoping unit tests.
 *
 * Verifies the partition-key identity that guarantees two different codebases
 * are never summarized together:
 *   1. _normalizeRoot collapses /home/<user>/ and /Users/<user>/ to ~/ so
 *      historical (redacted) and live paths for one codebase converge.
 *   2. _extractProjectRoot prefers an explicit metadata.projectRoot.
 *   3. Same basename + different absolute roots => DIFFERENT keys (no collision).
 *   4. Path-marker derivation recovers the root from modifiedFiles/readFiles.
 *   5. No evidence => isolated 'unknown'.
 *   6. _projectKey returns the basename label + the root key.
 *   7. Grouping a two-root observation set yields two disjoint buckets, and a
 *      roots selection filters to only the chosen root.
 *
 * ESM-only: package.json declares "type": "module" and jest runs with
 * --experimental-vm-modules.
 */

import { ObservationConsolidator } from '../../src/live-logging/ObservationConsolidator.js';

const c = new ObservationConsolidator({ dbPath: '/tmp/obs-root-test/.observations/observations.db' });

const obs = (metadata) => ({ metadata: JSON.stringify(metadata) });

describe('ObservationConsolidator project-root scoping', () => {
  test('_normalizeRoot collapses home/Users user prefix to ~/', () => {
    expect(c._normalizeRoot('/home/alice/work/repoA')).toBe('~/work/repoA');
    expect(c._normalizeRoot('/Users/bob/work/repoA')).toBe('~/work/repoA');
    // Same codebase, different machines/users -> identical key.
    expect(c._normalizeRoot('/home/alice/work/repoA'))
      .toBe(c._normalizeRoot('/Users/bob/work/repoA'));
    expect(c._normalizeRoot('/home/alice/work/repoA/')).toBe('~/work/repoA');
    expect(c._normalizeRoot('')).toBeNull();
  });

  test('_extractProjectRoot prefers explicit metadata.projectRoot', () => {
    const key = c._extractProjectRoot({ project: 'repoA', projectRoot: '/home/alice/code/repoA' });
    expect(key).toBe('~/code/repoA');
  });

  test('same basename + different roots do not collide', () => {
    const a = c._extractProjectRoot({ project: 'app', projectRoot: '/home/alice/teamX/app' });
    const b = c._extractProjectRoot({ project: 'app', projectRoot: '/home/alice/teamY/app' });
    expect(a).not.toBe(b);
    expect(a).toBe('~/teamX/app');
    expect(b).toBe('~/teamY/app');
  });

  test('path-marker derivation recovers root from file paths', () => {
    const key = c._extractProjectRoot({
      project: 'repoB',
      modifiedFiles: ['/home/alice/src/repoB/lib/foo.js'],
    });
    expect(key).toBe('~/src/repoB');
  });

  test('no evidence yields isolated unknown', () => {
    expect(c._extractProjectRoot({})).toBe('unknown');
    expect(c._extractProjectRoot({ project: 'unknown' })).toBe('unknown');
    expect(c._extractProjectRoot(null)).toBe('unknown');
  });

  test('_projectKey returns basename label and root key', () => {
    const { key, label } = c._projectKey(obs({ project: 'repoA', projectRoot: '/home/alice/code/repoA' }));
    expect(key).toBe('~/code/repoA');
    expect(label).toBe('repoA');
  });

  test('_projectKey label follows the resolved root, ignoring a stale basename', () => {
    // A pre-fix observation captured the legacy 'coding' default label but its
    // projectRoot resolves elsewhere. The label MUST follow the root basename
    // so the digest/insight is not mislabeled (e.g. obs-memory data under
    // 'coding') in the dashboard.
    const { key, label } = c._projectKey(
      obs({ project: 'coding', projectRoot: '/home/alice/work/obs-memory' })
    );
    expect(key).toBe('~/work/obs-memory');
    expect(label).toBe('obs-memory');
  });

  test('_cadenceSlug flattens a root key into a filesystem-safe sentinel slug', () => {
    expect(c._cadenceSlug('~/Ritwik/Memory/agent_agnostic/obs-memory'))
      .toBe('_Ritwik_Memory_agent_agnostic_obs-memory');
    expect(c._cadenceSlug('coding')).toBe('coding');
    expect(c._cadenceSlug('')).toBe('unknown');
  });

  test('two-root observation set partitions into disjoint buckets, roots selection filters', () => {
    const observations = [
      obs({ project: 'app', projectRoot: '/home/alice/teamX/app' }),
      obs({ project: 'app', projectRoot: '/home/alice/teamX/app' }),
      obs({ project: 'app', projectRoot: '/home/alice/teamY/app' }),
    ];

    const groupBy = (rows, roots = null) => {
      const filter = roots ? new Set(roots.map((r) => c._normalizeRoot(r) || r)) : null;
      const byRoot = new Map();
      for (const o of rows) {
        const { key, label } = c._projectKey(o);
        if (filter && !filter.has(key)) continue;
        if (!byRoot.has(key)) byRoot.set(key, { label, list: [] });
        byRoot.get(key).list.push(o);
      }
      return byRoot;
    };

    const all = groupBy(observations);
    expect(all.size).toBe(2);
    expect(all.get('~/teamX/app').list).toHaveLength(2);
    expect(all.get('~/teamY/app').list).toHaveLength(1);

    const scoped = groupBy(observations, ['/home/alice/teamX/app']);
    expect(scoped.size).toBe(1);
    expect([...scoped.keys()]).toEqual(['~/teamX/app']);
  });
});
