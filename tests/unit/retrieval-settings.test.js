/**
 * Unit tests for the persisted retrieval-settings store (clamp/validate/roundtrip).
 * Uses RETRIEVAL_SETTINGS_PATH to point the store at an isolated temp file, set
 * BEFORE the module is dynamically imported (SETTINGS_PATH is captured at load).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-settings-'));
const TMP_FILE = path.join(TMP_DIR, 'retrieval-settings.json');
process.env.RETRIEVAL_SETTINGS_PATH = TMP_FILE;

const mod = await import('../../src/retrieval/retrieval-settings.js');
const {
  defaultSettings,
  sanitizeSettings,
  getSettings,
  updateSettings,
  THRESHOLD_MIN,
  THRESHOLD_MAX,
  EXPONENT_MIN,
  EXPONENT_MAX,
} = mod;

afterAll(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  try {
    fs.rmSync(TMP_FILE, { force: true });
  } catch {
    /* ignore */
  }
});

describe('retrieval-settings', () => {
  test('defaultSettings has the two-stage shape with sane defaults', () => {
    const d = defaultSettings();
    expect(d).toHaveProperty('queryQuery.threshold');
    expect(d).toHaveProperty('queryQuery.exponentialEnabled');
    expect(d).toHaveProperty('queryQuery.exponent');
    expect(d).toHaveProperty('queryItem.threshold');
    expect(typeof d.queryQuery.exponentialEnabled).toBe('boolean');
    expect(typeof d.queryItem.exponentialEnabled).toBe('boolean');
  });

  test('sanitizeSettings clamps out-of-range values into bounds', () => {
    const s = sanitizeSettings({
      queryQuery: { threshold: 5, exponent: 999, exponentialEnabled: true },
      queryItem: { threshold: -1, exponent: 0, exponentialEnabled: false },
    });
    expect(s.queryQuery.threshold).toBe(THRESHOLD_MAX);
    expect(s.queryQuery.exponent).toBe(EXPONENT_MAX);
    expect(s.queryItem.threshold).toBe(THRESHOLD_MIN);
    expect(s.queryItem.exponent).toBe(EXPONENT_MIN);
  });

  test('sanitizeSettings fills garbage/missing fields from defaults', () => {
    const d = defaultSettings();
    const s = sanitizeSettings({ queryQuery: { threshold: 'nope' }, queryItem: null });
    expect(s.queryQuery.threshold).toBe(d.queryQuery.threshold);
    expect(s.queryItem).toEqual(d.queryItem);
  });

  test('getSettings fails open to defaults when file is absent', () => {
    expect(getSettings()).toEqual(defaultSettings());
  });

  test('updateSettings persists, clamps, and getSettings reflects it', () => {
    const saved = updateSettings({
      queryItem: { threshold: 0.82, exponentialEnabled: true, exponent: 4 },
    });
    expect(saved.queryItem.threshold).toBeCloseTo(0.82, 10);
    expect(saved.queryItem.exponentialEnabled).toBe(true);
    expect(saved.queryItem.exponent).toBe(4);
    // File written and reloaded by getSettings (mtime changed).
    expect(fs.existsSync(TMP_FILE)).toBe(true);
    const reread = getSettings();
    expect(reread.queryItem.threshold).toBeCloseTo(0.82, 10);
  });

  test('updateSettings merges partial updates without clobbering the other stage', () => {
    updateSettings({ queryQuery: { threshold: 0.9 } });
    const before = getSettings();
    updateSettings({ queryItem: { exponent: 6 } });
    const after = getSettings();
    expect(after.queryQuery.threshold).toBeCloseTo(before.queryQuery.threshold, 10);
    expect(after.queryItem.exponent).toBe(6);
  });

  test('updateSettings clamps over-range exponent on write', () => {
    const saved = updateSettings({ queryQuery: { exponent: 100 } });
    expect(saved.queryQuery.exponent).toBe(EXPONENT_MAX);
  });
});
