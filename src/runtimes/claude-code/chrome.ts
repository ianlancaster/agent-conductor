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

/**
 * The completed counterpart of the pulse row, rendered in the same slot once a
 * turn ends: glyph + single verb + `for <duration>`. Anchored tightly because a
 * false match here reports a working session as idle, which manufactures a
 * stall. `thought for 1s` inside a live pulse row's parenthetical cannot match:
 * the token after the verb there is the parenthesis, not `for`.
 */
const COMPLETED_TURN_ROW = /^\s*[·✢✳✶✻✽*]\s+\S+\s+for\s+\d+(?:\.\d+)?\s*[hms]\b/u;

const CONDUCTOR_STATUS_LINE = /\|\s*📁\s+.+\|\s*🌳\s+.+\|\s*🌿\s+/u;

/** True for blank lines and Claude's own frame furniture. */
function isFurniture(line: string): boolean {
  return line.trim().length === 0 || CHROME_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Classify the status row nearest the live edge of the frame, skipping
 * furniture. Returns undefined when the first substantive line is neither a
 * pulse nor a completed summary — the caller must not keep searching, because
 * anything further away belongs to an older frame.
 */
function classifyNearestStatusRow(
  lines: readonly string[],
  from: number,
  step: -1 | 1,
): PaneActivityEvidence | undefined {
  for (let index = from; index >= 0 && index < lines.length; index += step) {
    const line = lines[index] ?? '';
    // Turn evidence is tested before furniture: the interrupt hint and the
    // queued-message row are both chrome AND proof that a turn owns the pane.
    if (ACTIVE_TURN_PATTERNS.some((pattern) => pattern.test(line))) return 'working';
    if (COMPLETED_TURN_ROW.test(line)) return 'idle';
    if (isFurniture(line)) continue;
    return undefined;
  }
  return undefined;
}

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
 * Chrome of an interactive selection prompt — a permission request, a plan
 * confirmation, or an agent-authored `AskUserQuestion`. Its free-text option
 * renders with the same `❯` glyph as the composer, so an empty one is
 * indistinguishable from an empty input line by glyph alone.
 */
const SELECTION_PROMPT_PATTERNS: readonly RegExp[] = [
  /\bEnter to select\b/iu,
  /\bEsc to cancel\b/iu,
  /\bTab\/Arrow keys to navigate\b/iu,
  /❯\s*\d+\.\s+\S/u,
];

/** True when the frame is holding a selection prompt open. */
export function hasClaudeSelectionPrompt(capture: string): boolean {
  return SELECTION_PROMPT_PATTERNS.some((pattern) => pattern.test(capture));
}

/**
 * Classify the Claude Code input line. Looks at the LAST prompt-glyph line
 * in the capture: only an empty line is clear; any visible text is a draft.
 * Null when no input line is visible. Claude prompt suggestions are disabled
 * at launch because plain iTerm capture cannot distinguish them from input.
 *
 * A visible selection prompt is never classifiable. Its free-text option looks
 * exactly like an empty composer, and submitting into it answers a question
 * nobody asked Conductor to answer — typing a message into a menu both loses
 * the message and leaves the session holding a draft, which then blocks every
 * later delivery under the never-type-over-a-draft rule. Unknown is the safe
 * answer here: it queues.
 */
export function parseClaudeInputState(capture: string): InputState {
  if (hasClaudeSelectionPrompt(capture)) return null;
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

  let promptIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').includes('❯')) {
      promptIndex = index;
      break;
    }
  }
  // No composer at all: the bottom of the capture is the live edge.
  if (promptIndex < 0) return classifyNearestStatusRow(lines, lines.length - 1, -1) ?? 'unknown';

  // Claude renders the status row on either side of the composer, so consult
  // both neighbours of the live frame — below first, since queued-work chrome
  // and the interrupt hint only ever appear there.
  const below = classifyNearestStatusRow(lines, promptIndex + 1, 1);
  if (below !== undefined) return below;
  const above = classifyNearestStatusRow(lines, promptIndex - 1, -1);
  if (above !== undefined) return above;

  // Never scan the whole capture for an active-turn row. Scrollback retains the
  // final frame of every previous turn, so a stale pulse row would pin the
  // session to working forever and take fleet watch down with it.
  const trailing = lines.slice(promptIndex + 1);
  const onlyComposerChromeFollows = trailing.every((line) => isFurniture(line) || CONDUCTOR_STATUS_LINE.test(line));
  // An empty composer is idle evidence only when the frame is whole. A tall
  // draft pushes the status row out of the capture window; that is unknown, not
  // idle, or a peer's long message would stall the session that received it.
  return onlyComposerChromeFollows && promptIndex > 0 ? 'idle' : 'unknown';
}
