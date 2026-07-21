import { describe, expect, it } from 'vitest';
import { elapsedHours } from '../src/shepherd/time.js';

describe('reviewer escalation time', () => {
  it('counts every instant on configured Monday-Friday calendar days', () => {
    expect(elapsedHours('2026-07-17T12:00:00Z', new Date('2026-07-20T12:00:00Z'), true, 'UTC')).toBe(24);
    expect(elapsedHours('2026-07-17T12:00:00Z', new Date('2026-07-20T12:00:00Z'), false, 'UTC')).toBe(72);
  });

  it('uses the configured timezone for weekday boundaries', () => {
    const start = '2026-07-18T05:00:00Z'; // Friday 23:00 in Denver
    const end = new Date('2026-07-18T07:00:00Z'); // Saturday 01:00 in Denver
    expect(elapsedHours(start, end, true, 'America/Denver')).toBe(1);
  });
});
