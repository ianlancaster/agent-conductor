import type { TerminalBackend } from '../terminals/types.js';
import { cpuDeltaCentiseconds, sampleProcessCpu, type ProcessCpuRow } from '../terminals/process.js';
import { sleep } from './utils.js';
import type { PaneRef } from './types.js';

/**
 * How long the two cumulative-CPU samples are separated by. `ps` reports
 * cumulative CPU to centisecond resolution, so a one-second window resolves
 * roughly 1% of a core — far finer than the distinction being drawn.
 */
export const OUTSTANDING_WORK_WINDOW_MS = 1_000;

/**
 * CPU per window above which a seat is judged to have work in flight.
 *
 * Measured against a live seven-seat fleet rather than guessed. Idle seats are
 * NOT at zero: an agent process parked at its prompt still spends 0–3
 * centiseconds per second on timers and redraw, and the reading is noisy
 * between rounds. A single busy subprocess under the same seat measured 107
 * centiseconds per second. The threshold sits an order of magnitude above the
 * observed idle ceiling and an order of magnitude below one saturated core, so
 * neither end of that gap is close to it.
 */
export const OUTSTANDING_WORK_THRESHOLD_CENTISECONDS = 20;

/**
 * What the probe found for one seat.
 *
 * `unknown` is a first-class outcome, not an error to be swallowed. Reporting
 * an inconclusive probe as `quiet` fires a fleet stall into a working fleet;
 * reporting it as `in-flight` disables the instrument. Both are worse than
 * saying so.
 */
export type OutstandingWork =
  | { readonly state: 'in-flight'; readonly session: string; readonly detail: string }
  | { readonly state: 'quiet'; readonly session: string; readonly detail: string }
  | { readonly state: 'unknown'; readonly session: string; readonly detail: string };

export type OutstandingWorkProbe = (session: string) => Promise<OutstandingWork>;

export interface OutstandingWorkProbeDeps {
  backend: TerminalBackend;
  getPane(session: string): PaneRef | undefined;
  /** Injectable for tests; defaults to a real `ps` snapshot. */
  sample?: () => Promise<ProcessCpuRow[]>;
  /** Injectable for tests; defaults to a real delay. */
  wait?: (ms: number) => Promise<void>;
  windowMs?: number;
  thresholdCentiseconds?: number;
}

/**
 * Ask whether a seat has real work in flight, by measuring rather than counting.
 *
 * Counting descendant processes was tried first and is wrong: an idle seat is
 * not at zero, and what sits beneath it — `caffeinate`, stdio MCP servers — is
 * indistinguishable by count from a build. A `descendants > 0` term would
 * suppress fleet-stall permanently on any seat with an MCP server attached,
 * producing an instrument that can never fire. Parked helpers hold pids; they
 * do not hold the CPU.
 *
 * This is deliberately expensive enough that it belongs only on the
 * confirmation path — the moment a fleet stall would otherwise fire — and never
 * on the heartbeat.
 */
export function createOutstandingWorkProbe(deps: OutstandingWorkProbeDeps): OutstandingWorkProbe {
  const sample = deps.sample ?? sampleProcessCpu;
  const wait = deps.wait ?? sleep;
  const windowMs = deps.windowMs ?? OUTSTANDING_WORK_WINDOW_MS;
  const threshold = deps.thresholdCentiseconds ?? OUTSTANDING_WORK_THRESHOLD_CENTISECONDS;

  return async (session: string): Promise<OutstandingWork> => {
    const pane = deps.getPane(session);
    if (pane === undefined) {
      return { state: 'unknown', session, detail: 'no pane is recorded for this session' };
    }
    if (deps.backend.paneShellPid === undefined) {
      return {
        state: 'unknown',
        session,
        detail: `the ${deps.backend.name} backend cannot expose a pane process tree`,
      };
    }
    try {
      const rootPid = await deps.backend.paneShellPid(pane);
      const before = await sample();
      await wait(windowMs);
      const after = await sample();
      const { deltaCentiseconds, sampledProcesses } = cpuDeltaCentiseconds(before, after, rootPid);
      const measurement = `${String(deltaCentiseconds)}cs across ${String(sampledProcesses)} process(es) in ${String(windowMs)}ms`;
      if (sampledProcesses === 0) {
        // The tree vanished between samples, so nothing was actually measured.
        return { state: 'unknown', session, detail: 'the process tree was not observable across both samples' };
      }
      return deltaCentiseconds >= threshold
        ? { state: 'in-flight', session, detail: measurement }
        : { state: 'quiet', session, detail: measurement };
    } catch (error) {
      return { state: 'unknown', session, detail: error instanceof Error ? error.message : String(error) };
    }
  };
}
