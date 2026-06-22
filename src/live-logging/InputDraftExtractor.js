/**
 * InputDraftExtractor — extract the *typed-but-not-yet-submitted* prompt from a
 * tmux `capture-pane -p` snapshot of a coding-agent CLI.
 *
 * Why this exists
 * ---------------
 * GitHub Copilot CLI, Claude Code, and OpenCode all render an input box near the
 * bottom of the terminal while the user types. Because the prompt is not yet
 * submitted, no `UserPromptSubmit`-style hook has fired — the only place the draft
 * exists is on screen. `tmux capture-pane -p` returns a clean text snapshot of the
 * visible screen, so we can read the draft directly. This module turns that raw
 * snapshot into the current draft string.
 *
 * Design goals
 * ------------
 *  - Pure & deterministic: no I/O, no timers. Easy to unit-test.
 *  - Agent-agnostic: a small per-agent profile drives generic box/marker parsing.
 *  - Fail-quiet: any unexpected input returns null rather than throwing.
 *  - Cross-platform: operates on already-captured text; no shell/path assumptions.
 *
 * @module InputDraftExtractor
 */

/** Vertical box-side characters that wrap input-box content lines. */
const SIDE_BORDERS = '│┃|┆┇┊┋╎╏║';

/** Characters that begin a box TOP border line (also plain horizontal rules). */
const TOP_BORDER_CHARS = '╭┌┏╔';

/** Characters that begin a box BOTTOM border line. */
const BOTTOM_BORDER_CHARS = '╰└┗╚';

/** Horizontal rule characters (used to recognise pure border rows). */
const RULE_CHARS = '─━═-';

/** Block/cursor glyphs some CLIs render at the caret; stripped from drafts. */
const CURSOR_GLYPHS = /[█▏▎▍▌▋▊▉▐_]+$/u;

/**
 * Per-agent input profiles. `promptMarkers` are the glyphs that precede the
 * caret on the active input line. `placeholders` match empty-box hint text that
 * must never be treated as a real query. `extraNoise` augments the shared list.
 *
 * Keep these permissive: CLIs change their chrome between versions, so we match
 * on stable structural cues (box borders + a leading marker) rather than exact
 * pixel-perfect strings.
 */
export const AGENT_INPUT_PROFILES = {
  copilot: {
    promptMarkers: ['❯', '>', '▶', '›'],
    placeholders: [
      /^type your message/i,
      /^ask copilot/i,
      /^type @ to/i,
      /^how can i help/i,
    ],
    extraNoise: [/^github copilot$/i, /^claude-sonnet/i],
  },
  claude: {
    promptMarkers: ['>', '❯', '▶'],
    placeholders: [
      /^try ["“]/i,
      /^type your message/i,
      /^how can i help/i,
    ],
    extraNoise: [/^bypassing permissions$/i, /^plan mode/i],
  },
  opencode: {
    promptMarkers: ['>', '❯', '▶', '›'],
    placeholders: [
      /^type your message/i,
      /^ask anything/i,
      /^how can i help/i,
    ],
    extraNoise: [],
  },
};

/** A neutral default profile for unknown agents. */
const DEFAULT_PROFILE = {
  promptMarkers: ['❯', '>', '▶', '›'],
  placeholders: [/^type your message/i, /^how can i help/i],
  extraNoise: [],
};

/**
 * Shared UI-noise matchers. These describe hint/status chrome that the CLIs draw
 * around the input box and must never be retrieved on.
 */
const SHARED_NOISE = [
  /^\?\s*for (shortcuts|commands)/i,
  /^\/\s*for commands/i,
  /^esc to/i,
  /^ctrl\+/i,
  /^shift\+tab/i,
  /^tab\s/i,
  /^⏎\s*send/i,
  /^↑↓?\s*history/i,
  /^press /i,
  /accept edits$/i,
  /^\d+\s+(file|token|line)s?\b/i,
  /^⎇/,
];

/**
 * Resolve an agent name (or an already-built profile object) to a profile.
 *
 * @param {string|object} agent - Agent name (`copilot`|`claude`|`opencode`) or profile.
 * @returns {object} Resolved profile (never null).
 */
export function getProfile(agent) {
  if (agent && typeof agent === 'object') return { ...DEFAULT_PROFILE, ...agent };
  const key = String(agent || '').toLowerCase();
  return AGENT_INPUT_PROFILES[key] || DEFAULT_PROFILE;
}

/**
 * Strip leading box-side border + whitespace and trailing box-side border +
 * whitespace from a single captured line.
 *
 * @param {string} line
 * @returns {string} Inner content of the line.
 */
function stripSideBorders(line) {
  let s = line.replace(/\s+$/u, '');
  // Leading side border (one) + following spaces.
  const lead = new RegExp(`^\\s*[${escapeForClass(SIDE_BORDERS)}]\\s?`, 'u');
  s = s.replace(lead, '');
  // Trailing side border (one) + preceding spaces.
  const trail = new RegExp(`\\s*[${escapeForClass(SIDE_BORDERS)}]\\s*$`, 'u');
  s = s.replace(trail, '');
  return s;
}

/** Escape a character set for safe inclusion in a RegExp character class. */
function escapeForClass(chars) {
  return chars.replace(/[\\\]^-]/g, '\\$&');
}

/**
 * True when a line is a pure box border / horizontal rule (top, bottom, or a row
 * made only of rule + corner characters).
 *
 * @param {string} line
 * @returns {boolean}
 */
function isBorderLine(line) {
  const t = line.trim();
  if (!t) return false;
  const first = t[0];
  if (TOP_BORDER_CHARS.includes(first) || BOTTOM_BORDER_CHARS.includes(first)) return true;
  // A row consisting solely of rule/side/corner glyphs and spaces.
  const onlyBorder = new RegExp(
    `^[\\s${escapeForClass(RULE_CHARS + SIDE_BORDERS + TOP_BORDER_CHARS + BOTTOM_BORDER_CHARS + '╮╯┐┘┓┛╗╝')}]+$`,
    'u'
  );
  return onlyBorder.test(t);
}

/**
 * Detect a leading prompt marker on a line's inner content and return the text
 * that follows it. Returns null when no configured marker leads the content.
 *
 * @param {string} inner - Line content with side borders already removed.
 * @param {string[]} markers - Candidate prompt markers for the agent.
 * @returns {string|null} Draft text after the marker, or null.
 */
function afterPromptMarker(inner, markers) {
  const s = inner.replace(/^\s+/u, '');
  for (const m of markers) {
    if (s.startsWith(m)) {
      const rest = s.slice(m.length);
      // Require whitespace (or end) after marker so we don't eat ">text" headers.
      if (rest === '' || /^\s/u.test(rest)) {
        return rest.replace(/^\s+/u, '');
      }
    }
  }
  return null;
}

/**
 * Normalise a candidate draft: strip a trailing cursor glyph and surrounding
 * whitespace, and collapse internal runs of whitespace introduced by padding.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeDraft(text) {
  return text
    .replace(CURSOR_GLYPHS, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * True when `text` is UI noise / placeholder / a slash-command palette entry and
 * therefore must NOT be used as a query.
 *
 * @param {string} text - Already-normalised candidate draft.
 * @param {object} profile - Agent profile.
 * @returns {boolean}
 */
export function isNoise(text, profile = DEFAULT_PROFILE) {
  if (!text) return true;
  const all = [...SHARED_NOISE, ...(profile.placeholders || []), ...(profile.extraNoise || [])];
  return all.some((re) => re.test(text));
}

/**
 * Extract the current input draft from a tmux capture-pane snapshot.
 *
 * Strategy (bottom-up, structure-first):
 *   1. Look only within the bottom `scanLines` rows — the input box lives there.
 *   2. Find the last line whose (border-stripped) content begins with a prompt
 *      marker. That's the first physical row of the draft.
 *   3. Append following bordered content rows (wrapped draft lines) until the
 *      box's bottom border, joining with a space.
 *   4. Normalise and reject placeholders / UI noise / too-short fragments.
 *
 * @param {string} captureText - Raw `tmux capture-pane -p` output.
 * @param {string|object} agent - Agent name or profile.
 * @param {object} [opts]
 * @param {number} [opts.scanLines=18] - How many bottom rows to scan.
 * @param {number} [opts.minLength=3] - Minimum normalised draft length to accept.
 * @param {number} [opts.maxLength=500] - Hard cap (matches retrieval API limit).
 * @returns {string|null} The draft query, or null when there is nothing usable.
 */
export function extractDraft(captureText, agent, opts = {}) {
  if (!captureText || typeof captureText !== 'string') return null;
  const profile = getProfile(agent);
  const { scanLines = 18, minLength = 3, maxLength = 500 } = opts;

  const allLines = captureText.replace(/\r/g, '').split('\n');
  const start = Math.max(0, allLines.length - scanLines);
  const region = allLines.slice(start);

  // Find the prompt line (last marker hit, scanning bottom-up).
  let promptIdx = -1;
  let firstDraftPart = null;
  for (let i = region.length - 1; i >= 0; i--) {
    const inner = stripSideBorders(region[i]);
    const after = afterPromptMarker(inner, profile.promptMarkers);
    if (after !== null) {
      promptIdx = i;
      firstDraftPart = after;
      break;
    }
  }
  if (promptIdx === -1) return null;

  // Gather wrapped continuation rows (bordered, non-border, until bottom border).
  const parts = [firstDraftPart];
  for (let j = promptIdx + 1; j < region.length; j++) {
    const raw = region[j];
    if (isBorderLine(raw)) break; // reached box bottom (or a rule) -> stop
    const inner = stripSideBorders(raw);
    // Continuation rows have no prompt marker; ignore anything that looks like a
    // fresh marker line or that is empty.
    if (afterPromptMarker(inner, profile.promptMarkers) !== null) break;
    const trimmed = inner.trim();
    if (trimmed) parts.push(trimmed);
  }

  const draft = normalizeDraft(parts.join(' '));
  if (draft.length < minLength) return null;
  if (isNoise(draft, profile)) return null;
  // Slash-command / mention-only fragments are not real queries.
  if (/^[/@]\S*$/.test(draft)) return null;

  return draft.length > maxLength ? draft.slice(0, maxLength) : draft;
}

export default { extractDraft, isNoise, getProfile, AGENT_INPUT_PROFILES };
