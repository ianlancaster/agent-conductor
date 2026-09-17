import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scheduleOccurrenceId, type ScheduleOccurrenceAdmission } from '../src/core/schedule-occurrences.js';
import { Store } from '../src/store/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function occurrence(overrides: Partial<ScheduleOccurrenceAdmission> = {}): ScheduleOccurrenceAdmission {
  const scheduledAt = overrides.scheduledAt ?? '2026-09-17T15:00:00.000Z';
  const session = overrides.session ?? 'alpha';
  const scheduleIndex = overrides.scheduleIndex ?? 0;
  const label = overrides.label ?? 'review';
  const period = overrides.period ?? '0 9 * * *';
  return {
    id: scheduleOccurrenceId(session, scheduleIndex, label, period, scheduledAt),
    session,
    scheduleIndex,
    label,
    period,
    scheduledAt,
    timezone: 'America/Denver',
    envelope:
      '[Cron name="review" period="0 9 * * *" scheduled_at="2026-09-17T15:00:00.000Z" timezone="America/Denver"] inspect',
    wakeIfStopped: false,
    freshContext: false,
    ...overrides,
  };
}

describe('schedule occurrence identity', () => {
  it('is stable for a repeated callback of the same retained occurrence', () => {
    const first = scheduleOccurrenceId('alpha', 0, 'review', '0 9 * * *', '2026-09-17T15:00:00.000Z');
    const repeated = scheduleOccurrenceId('alpha', 0, 'review', '0 9 * * *', '2026-09-17T15:00:00.000Z');

    expect(repeated).toBe(first);
    expect(first).toMatch(/^schedule:[a-f0-9]{64}$/u);
  });

  it('separates adjacent occurrences and otherwise-identical configured entries', () => {
    const base = scheduleOccurrenceId('alpha', 0, 'review', '0 9 * * *', '2026-09-17T15:00:00.000Z');

    expect(scheduleOccurrenceId('alpha', 0, 'review', '0 9 * * *', '2026-09-18T15:00:00.000Z')).not.toBe(base);
    expect(scheduleOccurrenceId('alpha', 1, 'review', '0 9 * * *', '2026-09-17T15:00:00.000Z')).not.toBe(base);
  });

  it('deduplicates a repeated immutable identity and guards collisions', () => {
    const store = new Store(':memory:');
    try {
      const admission = occurrence();
      expect(store.admit(admission).deduplicated).toBe(false);
      expect(store.admit(admission)).toMatchObject({ deduplicated: true });
      expect(() => store.admit({ ...admission, envelope: 'different' })).toThrow(/identity collision/u);
    } finally {
      store.close();
    }
  });

  it('persists exact admitted provenance for restart replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-schedule-occurrence-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'conductor.db');
    const first = new Store(dbPath);
    const admission = occurrence();
    first.admit(admission);
    first.close();

    const reopened = new Store(dbPath);
    try {
      expect(reopened.recoverAdmitted()).toEqual([
        expect.objectContaining({
          ...admission,
          state: 'admitted',
          outcome: null,
          dispatchStartedAt: null,
          settledAt: null,
        }),
      ]);
    } finally {
      reopened.close();
    }
  });

  it('replays proved-no-write rollback but quarantines an interrupted effect', () => {
    const store = new Store(':memory:');
    try {
      const retryable = occurrence();
      store.admit(retryable);
      expect(store.markDispatching(retryable.id)).toBe(true);
      expect(store.restoreAdmitted(retryable.id)).toBe(true);
      expect(store.recoverAdmitted().map((row) => row.id)).toEqual([retryable.id]);

      expect(store.markDispatching(retryable.id)).toBe(true);
      expect(store.quarantineInterruptedDispatches()).toEqual([
        expect.objectContaining({ id: retryable.id, state: 'unknown', outcome: null }),
      ]);
      expect(store.recoverAdmitted()).toEqual([]);
      expect(store.getScheduleOccurrence(retryable.id)).toMatchObject({ state: 'unknown', outcome: null });
    } finally {
      store.close();
    }
  });
});
