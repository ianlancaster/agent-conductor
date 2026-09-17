import { describe, expect, it } from 'vitest';
import { scheduleOccurrenceId } from '../src/core/schedule-occurrences.js';

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
});
