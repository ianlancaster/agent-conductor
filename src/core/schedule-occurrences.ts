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
  settle(id: string, from: 'admitted' | 'dispatching', outcome: ScheduleOccurrenceOutcome): boolean;
  /** A terminal write may have happened, so this occurrence must never replay automatically. */
  markUnknown(id: string): boolean;
  /** Move dispatching rows left by an earlier process to non-replayable unknown. */
  quarantineInterruptedDispatches(): ScheduleOccurrenceRow[];
}

/** Non-durable fallback for isolated embeddings; Supervisor always injects Store. */
export class MemoryScheduleOccurrenceLedger implements ScheduleOccurrenceLedger {
  private readonly rows = new Map<string, ScheduleOccurrenceRow>();

  admit(admission: ScheduleOccurrenceAdmission): ScheduleOccurrenceInsertResult {
    const existing = this.rows.get(admission.id);
    if (existing !== undefined) return { row: existing, deduplicated: true };
    const row: ScheduleOccurrenceRow = {
      ...admission,
      state: 'admitted',
      outcome: null,
      admittedAt: new Date().toISOString(),
      dispatchStartedAt: null,
      settledAt: null,
    };
    this.rows.set(row.id, row);
    return { row, deduplicated: false };
  }

  recoverAdmitted(): ScheduleOccurrenceRow[] {
    return [...this.rows.values()].filter((row) => row.state === 'admitted');
  }

  markDispatching(id: string): boolean {
    return this.transition(id, 'admitted', { state: 'dispatching', dispatchStartedAt: new Date().toISOString() });
  }

  restoreAdmitted(id: string): boolean {
    return this.transition(id, 'dispatching', { state: 'admitted', dispatchStartedAt: null });
  }

  settle(id: string, from: 'admitted' | 'dispatching', outcome: ScheduleOccurrenceOutcome): boolean {
    return this.transition(id, from, { state: 'settled', outcome, settledAt: new Date().toISOString() });
  }

  markUnknown(id: string): boolean {
    return this.transition(id, 'dispatching', { state: 'unknown', settledAt: new Date().toISOString() });
  }

  quarantineInterruptedDispatches(): ScheduleOccurrenceRow[] {
    const rows = [...this.rows.values()].filter((row) => row.state === 'dispatching');
    for (const row of rows) this.markUnknown(row.id);
    return rows.map((row) => this.rows.get(row.id) ?? row);
  }

  private transition(id: string, from: ScheduleOccurrenceState, patch: Partial<ScheduleOccurrenceRow>): boolean {
    const row = this.rows.get(id);
    if (row?.state !== from) return false;
    this.rows.set(id, { ...row, ...patch });
    return true;
  }
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
