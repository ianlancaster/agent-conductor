import type { PaneActivityEvidence } from '../../core/types.js';
import type { InputState } from '../types.js';

/** Claude Code TUI chrome patterns — lines stripped from pane captures before judgment. */
const CHROME_PATTERNS: RegExp[] = [
  /bypass permissions/i,
  /shift\+tab to cycle/i,
  /esc to interrupt/i,
  /ctrl\+t to show/i,
  /press up to edit queued/i,
  /^\s*[❯›>$%]\s*$/,
  /^[\s─│╭╮╰╯├┤┬┴┼═║╔╗╚╝─-╿]*$/,
];

/**
 * Claude's live pulse row. The verb and pulse glyph animate and are not a
 * stable API; the row shape is: pulse + verb/ellipsis + parenthesized live
 * turn metadata. Completed summaries use `* <verb> for <duration>` instead.
 */
const ACTIVE_TURN_PATTERNS: readonly RegExp[] = [
  /^\s*[·✢✳✶✻✽]\s+\S.*(?:…|\.\.\.)\s+\([^)]*\)\s*$/u,
  /^\s*Press up to edit queued messages\s*$/iu,
  /\bctrl\+c to interrupt\b/iu,
];
const CONDUCTOR_STATUS_LINE = /\|\s*📁\s+.+\|\s*🌳\s+.+\|\s*🌿\s+/u;

export function stripClaudeChrome(capture: string): string {
  const lines = capture.split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last === undefined) break;
    if (last.trim().length === 0 || CHROME_PATTERNS.some((pattern) => pattern.test(last))) {
      lines.pop();
    } else {
      break;
    }
  }
  return lines.join('\n');
}

/**
 * Classify the Claude Code input line. Looks at the LAST prompt-glyph line
 * in the capture: only an empty line is clear; any visible text is a draft.
 * Null when no input line is visible. Claude prompt suggestions are disabled
 * at launch because plain iTerm capture cannot distinguish them from input.
 */
export function parseClaudeInputState(capture: string): InputState {
  const lines = capture.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const glyphIndex = line.indexOf('❯');
    if (glyphIndex === -1) continue;
    const afterGlyph = line
      .slice(glyphIndex + 1)
      .replace(/[│┃|]/g, '')
      .trim();
    return afterGlyph.length === 0 ? 'clear' : 'draft';
  }
  return null;
}

/**
 * Classify Claude's execution state independently from input readiness. Claude
 * can keep a composer visible while a turn is executing, so its interrupt
 * chrome wins over every composer observation. Without an active-turn marker,
 * a composer is idle evidence only when no substantive output follows it.
 */
export function parseClaudeActivityState(capture: string): PaneActivityEvidence {
  const lines = capture.split('\n');
  if (lines.some((line) => ACTIVE_TURN_PATTERNS.some((pattern) => pattern.test(line)))) return 'working';

  let promptIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').includes('❯')) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) return 'unknown';
  const trailing = lines.slice(promptIndex + 1);
  const onlyComposerChromeFollows = trailing.every(
    (line) =>
      line.trim().length === 0 ||
      CHROME_PATTERNS.some((pattern) => pattern.test(line)) ||
      CONDUCTOR_STATUS_LINE.test(line),
  );
  return onlyComposerChromeFollows ? 'idle' : 'unknown';
}
