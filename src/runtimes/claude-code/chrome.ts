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
 * Whether the Claude Code input line is empty.
 * Looks at the LAST prompt-glyph line in the capture; text after the glyph
 * means the operator (or a queued message) is mid-composition.
 * Returns null when no input line is visible.
 */
export function parseClaudeInputClear(capture: string): boolean | null {
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
    return afterGlyph.length === 0;
  }
  return null;
}
