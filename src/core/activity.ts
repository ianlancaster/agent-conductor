import type { InputState, SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { PaneActivityEvidence, PaneRef } from './types.js';

/**
 * Observe execution state through a runtime-owned parser. This is deliberately
 * separate from composer/input readiness: a runtime may accept queued input
 * while its current turn is still executing.
 */
/**
 * How much deeper to look when the default window cannot classify the frame. A
 * long queued or drafted message expands the composer and pushes the runtime's
 * status row out of an ordinary capture; one bounded deeper look resolves it
 * instead of freezing the session's activity at its previous value.
 */
const AMBIGUOUS_CAPTURE_MULTIPLIER = 5;

/**
 * Observe the composer through the runtime-owned input parser. In particular,
 * this preserves styled-placeholder handling where the terminal backend can
 * provide it and runtime-owned ambiguity resolution where it cannot.
 */
export async function observePaneInputState(
  backend: TerminalBackend,
  runtime: SessionRuntime | undefined,
  session: string,
  pane: PaneRef,
  captureLines: number,
): Promise<InputState> {
  if (runtime === undefined) return null;
  try {
    const capture =
      runtime.capabilities.styledCapture && backend.captureStyled !== undefined
        ? await backend.captureStyled(pane, captureLines)
        : await backend.capture(pane, captureLines);
    const parsed = runtime.parseInputState(capture, session);
    return parsed !== 'clear' && runtime.resolveInputState !== undefined
      ? await runtime.resolveInputState(capture, session, parsed)
      : parsed;
  } catch {
    return null;
  }
}

export async function observePaneActivity(
  backend: TerminalBackend,
  runtime: SessionRuntime | undefined,
  session: string,
  pane: PaneRef,
  captureLines: number,
): Promise<PaneActivityEvidence> {
  if (runtime?.parseActivityState === undefined) return 'unknown';
  const parseAt = async (lines: number): Promise<PaneActivityEvidence> => {
    const capture =
      runtime.capabilities.styledCapture && backend.captureStyled !== undefined
        ? await backend.captureStyled(pane, lines)
        : await backend.capture(pane, lines);
    return runtime.parseActivityState?.(capture, session) ?? 'unknown';
  };
  try {
    const evidence = await parseAt(captureLines);
    if (evidence !== 'unknown') return evidence;
    return await parseAt(captureLines * AMBIGUOUS_CAPTURE_MULTIPLIER);
  } catch {
    return 'unknown';
  }
}
