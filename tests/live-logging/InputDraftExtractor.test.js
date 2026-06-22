/**
 * InputDraftExtractor Jest tests.
 *
 * Verifies the typed-but-unsent draft is correctly extracted from synthetic
 * `tmux capture-pane -p` snapshots for Copilot, Claude Code, and OpenCode,
 * including multi-line wrapping, and that placeholders / UI noise / slash
 * fragments are rejected.
 *
 * ESM-only: package.json declares `"type": "module"`.
 */

import { extractDraft, isNoise, getProfile } from '../../src/live-logging/InputDraftExtractor.js';

/** Build a bottom-anchored screen from header noise + box lines. */
function screen(...lines) {
  return [
    'Some earlier assistant output line',
    'another transcript line',
    '',
    ...lines,
  ].join('\n');
}

describe('InputDraftExtractor.extractDraft', () => {
  test('Copilot rounded box with ❯ marker', () => {
    const cap = screen(
      '╭───────────────────────────────────────────────╮',
      '│ ❯ implement retry logic for the http client     │',
      '╰───────────────────────────────────────────────╯',
      '  ? for shortcuts'
    );
    expect(extractDraft(cap, 'copilot')).toBe('implement retry logic for the http client');
  });

  test('Claude Code box with > marker', () => {
    const cap = screen(
      '╭──────────────────────────────────────────────╮',
      '│ > why is the dashboard websocket disconnecting │',
      '╰──────────────────────────────────────────────╯',
      '  ⏎ send   ? for shortcuts'
    );
    expect(extractDraft(cap, 'claude')).toBe('why is the dashboard websocket disconnecting');
  });

  test('OpenCode square box with > marker', () => {
    const cap = screen(
      '┌──────────────────────────────────────────────┐',
      '│ > add a unit test for the token budget module  │',
      '└──────────────────────────────────────────────┘'
    );
    expect(extractDraft(cap, 'opencode')).toBe('add a unit test for the token budget module');
  });

  test('markerless prompt line (pipe-capture fallback style)', () => {
    const cap = screen('❯ refactor the retrieval service into smaller files');
    expect(extractDraft(cap, 'copilot')).toBe('refactor the retrieval service into smaller files');
  });

  test('multi-line wrapped draft inside box is joined', () => {
    const cap = screen(
      '╭──────────────────────────────────────────────╮',
      '│ ❯ explain how working memory and observational  │',
      '│   memory are combined in the retrieval service │',
      '╰──────────────────────────────────────────────╯'
    );
    expect(extractDraft(cap, 'copilot')).toBe(
      'explain how working memory and observational memory are combined in the retrieval service'
    );
  });

  test('empty box returns null (no draft typed)', () => {
    const cap = screen(
      '╭──────────────────────────────────────────────╮',
      '│ >                                              │',
      '╰──────────────────────────────────────────────╯'
    );
    expect(extractDraft(cap, 'claude')).toBeNull();
  });

  test('placeholder hint text is rejected', () => {
    const cap = screen(
      '╭──────────────────────────────────────────────╮',
      '│ > Type your message                            │',
      '╰──────────────────────────────────────────────╯'
    );
    expect(extractDraft(cap, 'opencode')).toBeNull();
  });

  test('UI noise rows are rejected even when marker-led', () => {
    const cap = screen('> ? for shortcuts');
    expect(extractDraft(cap, 'copilot')).toBeNull();
  });

  test('slash-command-only fragment is rejected', () => {
    const cap = screen(
      '╭──────────────────────────────────────────────╮',
      '│ > /clear                                       │',
      '╰──────────────────────────────────────────────╯'
    );
    expect(extractDraft(cap, 'claude')).toBeNull();
  });

  test('trailing cursor glyph is stripped', () => {
    const cap = screen(
      '╭──────────────────────────────────────────────╮',
      '│ ❯ debug the memgraph connection█               │',
      '╰──────────────────────────────────────────────╯'
    );
    expect(extractDraft(cap, 'copilot')).toBe('debug the memgraph connection');
  });

  test('picks the bottom-most input box, not transcript history', () => {
    const cap = [
      '╭──────────────────────────────────────────────╮',
      '│ > an old already-submitted prompt              │',
      '╰──────────────────────────────────────────────╯',
      'assistant response text ...',
      'more output',
      '╭──────────────────────────────────────────────╮',
      '│ > the current draft being typed                │',
      '╰──────────────────────────────────────────────╯',
    ].join('\n');
    expect(extractDraft(cap, 'claude')).toBe('the current draft being typed');
  });

  test('too-short fragments are rejected', () => {
    const cap = screen('❯ ok');
    // "ok" is 2 chars, below default minLength 3
    expect(extractDraft(cap, 'copilot')).toBeNull();
  });

  test('null / non-string input returns null', () => {
    expect(extractDraft(null, 'copilot')).toBeNull();
    expect(extractDraft(undefined, 'copilot')).toBeNull();
    expect(extractDraft(42, 'copilot')).toBeNull();
  });
});

describe('InputDraftExtractor helpers', () => {
  test('getProfile falls back to default for unknown agent', () => {
    const p = getProfile('totally-unknown');
    expect(Array.isArray(p.promptMarkers)).toBe(true);
    expect(p.promptMarkers.length).toBeGreaterThan(0);
  });

  test('isNoise flags shortcuts and placeholders', () => {
    expect(isNoise('? for shortcuts', getProfile('copilot'))).toBe(true);
    expect(isNoise('Type your message', getProfile('opencode'))).toBe(true);
    expect(isNoise('implement a feature', getProfile('copilot'))).toBe(false);
  });
});
