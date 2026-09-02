import { describe, expect, it } from 'vitest';
import { CONDUCTOR_START_TIMEOUT_MS, waitForConductorStart } from '../src/cli/startup.js';

describe('detached Conductor startup wait', () => {
  it('allows a slow healthy startup within the 60-second deadline', async () => {
    let now = 0;

    const started = await waitForConductorStart({
      conductorUp: async () => now >= 20_000,
      childExited: () => false,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    expect(CONDUCTOR_START_TIMEOUT_MS).toBe(60_000);
    expect(started).toBe(true);
    expect(now).toBe(20_000);
  });

  it('stops polling at the startup deadline', async () => {
    let now = 0;

    const started = await waitForConductorStart({
      conductorUp: async () => false,
      childExited: () => false,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    expect(started).toBe(false);
    expect(now).toBe(60_000);
  });

  it('stops polling when the child exits before readiness', async () => {
    const started = await waitForConductorStart({
      conductorUp: async () => false,
      childExited: () => true,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(started).toBe(false);
  });
});
