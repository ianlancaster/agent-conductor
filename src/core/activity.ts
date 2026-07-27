import type { SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { PaneActivityEvidence, PaneRef } from './types.js';

/**
 * Observe execution state through a runtime-owned parser. This is deliberately
 * separate from composer/input readiness: a runtime may accept queued input
 * while its current turn is still executing.
 */
export async function observePaneActivity(
  backend: TerminalBackend,
  runtime: SessionRuntime | undefined,
  session: string,
  pane: PaneRef,
  captureLines: number,
): Promise<PaneActivityEvidence> {
  if (runtime?.parseActivityState === undefined) return 'unknown';
  try {
    const capture =
      runtime.capabilities.styledCapture && backend.captureStyled !== undefined
        ? await backend.captureStyled(pane, captureLines)
        : await backend.capture(pane, captureLines);
    return runtime.parseActivityState(capture, session);
  } catch {
    return 'unknown';
  }
}
