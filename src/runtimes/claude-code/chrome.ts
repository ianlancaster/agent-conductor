import { ENVELOPE_SIGNATURE } from '../../core/utils.js';
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
 * Ghost/placeholder text Claude Code renders inside an EMPTY input box (e.g.
 * `❯ Try "fix lint errors"`). Pane captures are plain text, so it is
 * indistinguishable from typed input by styling — match its shape instead.
 * Treating it as typed input made an idle session read "busy" forever, so
 * deliveries only ever went out via the max-age force-flush.
 */
const GHOST_TEXT_PATTERN = /^Try ["“'].*["”']( to .*)?$/;

/**
 * Classify the Claude Code input line. Looks at the LAST prompt-glyph line
 * in the capture: empty (or the placeholder ghost text, which only appears
 * when the input is empty) is clear; a draft bearing a conductor envelope
 * signature is one of our own unsubmitted deliveries; any other draft is
 * the operator mid-composition. Null when no input line is visible.
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
    if (afterGlyph.length === 0 || GHOST_TEXT_PATTERN.test(afterGlyph)) return 'clear';
    return ENVELOPE_SIGNATURE.test(afterGlyph) ? 'conductor-draft' : 'operator-draft';
  }
  return null;
}
