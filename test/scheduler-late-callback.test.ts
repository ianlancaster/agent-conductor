import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '../src/config/schema.js';

const { selectedTargets } = vi.hoisted(() => ({ selectedTargets: [] as number[] }));

vi.mock('croner', () => ({
  Cron: class {
    private selected = false;

    nextRun(): Date | null {
      if (this.selected) return null;
      this.selected = true;
      const target = Date.now() + 50;
      selectedTargets.push(target);
      return new Date(target);
    }

    stop(): void {
      return undefined;
    }
  },
}));

import { Scheduler } from '../src/core/scheduler.js';

let scheduler: Scheduler | undefined;

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  selectedTargets.length = 0;
});

describe('Scheduler delayed timer callback', () => {
  it('delivers the target retained before an event-loop delay', async () => {
    const delivered: string[] = [];
    const sessions = new Map<string, SessionConfig>([
      [
        'alpha',
        {
          codename: 'alpha',
          repo: '/tmp/alpha',
          runtime: 'codex',
          additionalDirs: [],
          schedules: [
            {
              cron: '* * * * * *',
              prompt: 'late tick',
              paused: false,
              freshContext: false,
              wakeIfStopped: false,
            },
          ],
        },
      ],
    ]);
    scheduler = new Scheduler({
      sessions: () => sessions,
      isActive: () => true,
      isPaused: () => false,
      startSession: async () => 'started',
      stopSession: async () => 'stopped',
      deliver: async (_session, text, options) => {
        delivered.push(text);
        if (options.onSubmissionStarted?.() === false) return 'uncertain';
        options.onDelivered?.();
        return 'delivered';
      },
    });
    scheduler.rebuild();
    const selectedAt = selectedTargets[0];
    expect(selectedAt).toBeDefined();

    // Deliberately prevent the 50 ms timer from running until well after its
    // target. The delivered identity must still be the pre-delay target.
    const blockedUntil = Date.now() + 100;
    while (Date.now() < blockedUntil) {
      // Event-loop blockage is the condition under test.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(`scheduled_at=${JSON.stringify(new Date(selectedAt!).toISOString())}`);
    expect(delivered[0]).not.toContain(`scheduled_at=${JSON.stringify(new Date().toISOString())}`);
  });
});
