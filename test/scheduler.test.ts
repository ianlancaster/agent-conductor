import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionConfigSchema } from '../src/config/schema.js';
import type { z } from 'zod';
import type { SessionConfig } from '../src/config/schema.js';
import { Scheduler } from '../src/core/scheduler.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';

function sessionWith(schedules: z.input<typeof sessionConfigSchema>['schedules']): SessionConfig {
  return sessionConfigSchema.parse({ codename: 'alpha', repo: '/tmp/alpha', schedules });
}

let scheduler: Scheduler;
let sessions: Map<string, SessionConfig>;
let active: boolean;
let paused: boolean;
let started: { session: string; prompt?: string }[];
let stopped: string[];
let delivered: { session: string; text: string }[];
let events: FakeEventPublisher;

beforeEach(() => {
  vi.useFakeTimers();
  // Pin to a fixed sub-second offset (.500) so an every-second cron advanced by
  // 1100ms deterministically crosses exactly ONE boundary. Without this the fake
  // clock starts at the real wall-clock time, and a 1100ms window straddles one
  // or two second boundaries depending on that offset — a genuine flake source.
  vi.setSystemTime(new Date('2026-01-02T03:04:05.500Z'));
  sessions = new Map();
  active = false;
  paused = false;
  started = [];
  stopped = [];
  delivered = [];
  events = new FakeEventPublisher();
  scheduler = new Scheduler({
    sessions: () => sessions,
    isActive: () => active,
    isPaused: () => paused,
    startSession: async (session, opts) => {
      started.push({ session, prompt: opts.prompt });
      active = true;
      return 'started';
    },
    stopSession: async (session) => {
      stopped.push(session);
      active = false;
      return 'stopped';
    },
    deliver: async (session, text) => {
      delivered.push({ session, text });
      return 'delivered';
    },
    events,
  });
});

afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
});

// croner supports 6-field (seconds) patterns — every-second schedules keep the
// fake-timer advances small.
const EVERY_SECOND = '* * * * * *';

describe('Scheduler', () => {
  it.each([false, true])('does not wake an inactive target by default (freshContext=%s)', async (freshContext) => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'do not wake', freshContext }]));
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(5100);
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
    expect(delivered).toEqual([]);
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: 'schedule-1',
      outcome: 'skipped-stopped',
    });
    active = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual([]); // no catch-up queue
  });

  it('starts an inactive fresh-context target only with wake opt-in', async () => {
    sessions.set(
      'alpha',
      sessionWith([{ cron: EVERY_SECOND, prompt: 'fresh', freshContext: true, wakeIfStopped: true }]),
    );
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).toEqual([{ session: 'alpha', prompt: `[Cron name="schedule-1" period="${EVERY_SECOND}"] fresh` }]);
    expect(stopped).toEqual([]);
  });

  it.each([false, true])('pause overrides wake opt-in (freshContext=%s)', async (freshContext) => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'held', wakeIfStopped: true, freshContext }]));
    paused = true;
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).toEqual([]);
    expect(delivered).toEqual([]);
    expect(events.events[0]).toMatchObject({ outcome: 'deferred-paused' });
  });

  it('honors explicit false after reloading an opted-in schedule', async () => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'tick', wakeIfStopped: true }]));
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).toHaveLength(1);
    active = false;
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'tick', wakeIfStopped: false }]));
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  it.each(['session stop', 'scheduler stop', 'reload'])(
    'cancels fresh-context restart during settle on %s',
    async (action) => {
      sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'nightly', freshContext: true }]));
      active = true;
      scheduler.rebuild();
      await vi.advanceTimersByTimeAsync(1100);
      expect(stopped).toEqual(['alpha']);
      if (action === 'session stop') scheduler.cancelSession('alpha');
      else if (action === 'scheduler stop') scheduler.stop();
      else scheduler.rebuild();
      await vi.advanceTimersByTimeAsync(4100);
      expect(started).toEqual([]);
      expect(delivered).toEqual([]);
      expect(events.events).toContainEqual({
        type: 'schedule',
        session: 'alpha',
        label: 'schedule-1',
        outcome: 'skipped-cancelled',
      });
    },
  );

  it('delivers the prompt into an active session', async () => {
    sessions.set(
      'alpha',
      sessionWith([{ label: 'heartbeat', cron: EVERY_SECOND, prompt: 'tick', paused: false, freshContext: false }]),
    );
    active = true;
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(delivered[0]).toEqual({
      session: 'alpha',
      text: `[Cron name="heartbeat" period="${EVERY_SECOND}"] tick`,
    });
    expect(started).toEqual([]);
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: 'heartbeat',
      outcome: 'fired',
    });
  });

  it('starts an inactive session with an explicit wake opt-in', async () => {
    sessions.set(
      'alpha',
      sessionWith([{ cron: EVERY_SECOND, prompt: 'wake up', wakeIfStopped: true, paused: false, freshContext: false }]),
    );
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started[0]).toEqual({
      session: 'alpha',
      prompt: `[Cron name="schedule-1" period="${EVERY_SECOND}"] wake up`,
    });
    expect(delivered).toEqual([]);
  });

  it('stops then restarts for freshContext schedules', async () => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'nightly', paused: false, freshContext: true }]));
    active = true;
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100); // fire -> stop + settle sleep begins
    expect(stopped).toEqual(['alpha']);
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(3100); // settle period elapses
    expect(started[0]).toEqual({
      session: 'alpha',
      prompt: `[Cron name="schedule-1" period="${EVERY_SECOND}"] nightly`,
    });
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: 'schedule-1',
      outcome: 'fired-fresh',
    });
  });

  it('defers when the session is paused', async () => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'tick', paused: false, freshContext: false }]));
    paused = true;
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).toEqual([]);
    expect(delivered).toEqual([]);
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: 'schedule-1',
      outcome: 'deferred-paused',
    });
  });

  it('rechecks pause after asynchronous activity reconciliation before delivering', async () => {
    let finishInspection: ((active: boolean) => void) | undefined;
    scheduler = new Scheduler({
      sessions: () => sessions,
      isActive: () =>
        new Promise<boolean>((resolve) => {
          finishInspection = resolve;
        }),
      isPaused: () => paused,
      startSession: async (session, opts) => {
        started.push({ session, prompt: opts.prompt });
        return 'started';
      },
      stopSession: async () => 'stopped',
      deliver: async (session, text) => {
        delivered.push({ session, text });
      },
      events,
    });
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'tick', paused: false, freshContext: false }]));
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    paused = true;
    finishInspection?.(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(started).toEqual([]);
    expect(delivered).toEqual([]);
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: 'schedule-1',
      outcome: 'deferred-paused',
    });
  });

  it('rechecks pause before restarting a fresh-context schedule after its settle delay', async () => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'nightly', paused: false, freshContext: true }]));
    active = true;
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(stopped).toEqual(['alpha']);

    paused = true;
    await vi.advanceTimersByTimeAsync(3100);
    expect(started).toEqual([]);
    expect(delivered).toEqual([]);
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: 'schedule-1',
      outcome: 'deferred-paused',
    });
  });

  it('skips schedule entries marked paused', async () => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'tick', paused: true, freshContext: false }]));
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(2100);
    expect(started).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('tolerates invalid cron patterns without dropping valid ones', async () => {
    sessions.set(
      'alpha',
      sessionWith([
        { cron: 'not a cron', prompt: 'never', paused: false, freshContext: false },
        { cron: EVERY_SECOND, prompt: 'still works', wakeIfStopped: true, paused: false, freshContext: false },
      ]),
    );
    expect(() => {
      scheduler.rebuild();
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started[0]?.prompt).toBe(`[Cron name="schedule-2" period="${EVERY_SECOND}"] still works`);
  });

  it('rebuild replaces jobs and stop() cancels them', async () => {
    sessions.set(
      'alpha',
      sessionWith([{ cron: EVERY_SECOND, prompt: 'tick', wakeIfStopped: true, paused: false, freshContext: false }]),
    );
    scheduler.rebuild();
    scheduler.rebuild(); // must not double-arm
    await vi.advanceTimersByTimeAsync(1100);
    expect(started.length).toBe(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(started.length).toBe(1);
  });

  it('serializes simultaneous schedules for one inactive session without losing a prompt', async () => {
    sessions.set(
      'alpha',
      sessionWith([
        { cron: EVERY_SECOND, prompt: 'first', wakeIfStopped: true, paused: false, freshContext: false },
        { cron: EVERY_SECOND, prompt: 'second', wakeIfStopped: true, paused: false, freshContext: false },
      ]),
    );
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);

    expect(started).toEqual([{ session: 'alpha', prompt: `[Cron name="schedule-1" period="${EVERY_SECOND}"] first` }]);
    expect(delivered).toEqual([{ session: 'alpha', text: `[Cron name="schedule-2" period="${EVERY_SECOND}"] second` }]);
  });

  it('uses an asynchronous authoritative activity check', async () => {
    let inspected = 0;
    scheduler = new Scheduler({
      sessions: () => sessions,
      isActive: async () => {
        inspected += 1;
        return false;
      },
      isPaused: () => false,
      startSession: async (session, opts) => {
        started.push({ session, prompt: opts.prompt });
        return 'started';
      },
      stopSession: async () => 'stopped',
      deliver: async (session, text) => {
        delivered.push({ session, text });
      },
      events,
    });
    sessions.set(
      'alpha',
      sessionWith([{ cron: EVERY_SECOND, prompt: 'restart', wakeIfStopped: true, paused: false, freshContext: false }]),
    );
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(inspected).toBe(1);
    expect(started[0]?.prompt).toBe(`[Cron name="schedule-1" period="${EVERY_SECOND}"] restart`);
    expect(delivered).toEqual([]);
  });

  it('emits a mechanical failed outcome without exposing the error text', async () => {
    scheduler = new Scheduler({
      sessions: () => sessions,
      isActive: () => false,
      isPaused: () => false,
      startSession: async () => {
        throw new Error('secret provider detail');
      },
      stopSession: async () => 'stopped',
      deliver: async () => undefined,
      events,
    });
    sessions.set(
      'alpha',
      sessionWith([
        {
          cron: EVERY_SECOND,
          prompt: 'restart',
          wakeIfStopped: true,
          label: 'safe label',
          paused: false,
          freshContext: false,
        },
      ]),
    );
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: 'safe label',
      outcome: 'failed',
    });
    expect(JSON.stringify(events.events)).not.toContain('secret provider detail');
  });
});
