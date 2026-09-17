import { createHash } from 'node:crypto';
import type { ScheduleSource } from './utils.js';

export type ScheduleOccurrenceState = 'admitted' | 'dispatching' | 'settled' | 'unknown';

export type ScheduleOccurrenceOutcome =
  'fired' | 'fired-fresh' | 'deferred-paused' | 'skipped-stopped' | 'skipped-cancelled' | 'failed';

/** Complete durable input captured before an occurrence enters per-session serialization. */
export interface ScheduleOccurrenceAdmission extends ScheduleSource {
  id: string;
  session: string;
  scheduleIndex: number;
  label: string;
  period: string;
  envelope: string;
  wakeIfStopped: boolean;
  freshContext: boolean;
}

export interface ScheduleOccurrenceRow extends ScheduleOccurrenceAdmission {
  state: ScheduleOccurrenceState;
  outcome: ScheduleOccurrenceOutcome | null;
  admittedAt: string;
  dispatchStartedAt: string | null;
  settledAt: string | null;
}

export interface ScheduleOccurrenceInsertResult {
  row: ScheduleOccurrenceRow;
  deduplicated: boolean;
}

/**
 * Compare-and-set persistence used by Scheduler. Implementations must never
 * automatically replay `dispatching` or `unknown`: a terminal effect may have
 * happened even when its acknowledgement did not.
 */
export interface ScheduleOccurrenceLedger {
  admit(admission: ScheduleOccurrenceAdmission): ScheduleOccurrenceInsertResult;
  recoverAdmitted(): ScheduleOccurrenceRow[];
  markDispatching(id: string): boolean;
  /** Valid only after delivery proves that no terminal submission occurred. */
  restoreAdmitted(id: string): boolean;
  settle(id: string, outcome: ScheduleOccurrenceOutcome): boolean;
  /** Move dispatching rows left by an earlier process to non-replayable unknown. */
  quarantineInterruptedDispatches(): ScheduleOccurrenceRow[];
}

/** Stable identity for duplicate callbacks/recovery, independent of handling time. */
export function scheduleOccurrenceId(
  session: string,
  scheduleIndex: number,
  label: string,
  period: string,
  scheduledAt: string,
): string {
  const identity = JSON.stringify([session, scheduleIndex, label, period, scheduledAt]);
  return `schedule:${createHash('sha256').update(identity).digest('hex')}`;
}
