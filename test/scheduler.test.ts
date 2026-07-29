import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '../src/config/schema.js';
import { Scheduler } from '../src/core/scheduler.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';

function sessionWith(schedules: SessionConfig['schedules']): SessionConfig {
  return { codename: 'alpha', repo: '/tmp/alpha', runtime: 'claude-code', additionalDirs: [], schedules };
}

let scheduler: Scheduler;
let sessions: Map<string, SessionConfig>;
let active: boolean;
let deliveryResult: 'delivered' | 'queued';
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
  deliveryResult = 'delivered';
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
      return deliveryResult;
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
  it('delivers the prompt into an active session', async () => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'tick', paused: false, freshContext: false }]));
    active = true;
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(delivered[0]).toEqual({ session: 'alpha', text: 'tick' });
    expect(started).toEqual([]);
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: EVERY_SECOND,
      outcome: 'fired',
    });
  });

  it('says a schedule was held rather than reporting it as arrived', async () => {
    // Firing and arriving are different facts. A seat holding a prompt or a
    // draft cannot receive, and reporting `fired` for a message still sitting
    // in a queue tells the schedule's owner they have coverage they do not —
    // which is how ten consecutive fleet sweeps went unreported.
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'sweep', paused: false, freshContext: false }]));
    active = true;
    deliveryResult = 'queued';
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);

    expect(delivered[0]).toEqual({ session: 'alpha', text: 'sweep' });
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: EVERY_SECOND,
      outcome: 'queued',
    });
  });

  it('starts an inactive session with the prompt', async () => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'wake up', paused: false, freshContext: false }]));
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started[0]).toEqual({ session: 'alpha', prompt: 'wake up' });
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
    expect(started[0]).toEqual({ session: 'alpha', prompt: 'nightly' });
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: EVERY_SECOND,
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
      label: EVERY_SECOND,
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
        { cron: EVERY_SECOND, prompt: 'still works', paused: false, freshContext: false },
      ]),
    );
    expect(() => {
      scheduler.rebuild();
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started[0]?.prompt).toBe('still works');
  });

  it('rebuild replaces jobs and stop() cancels them', async () => {
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'tick', paused: false, freshContext: false }]));
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
        { cron: EVERY_SECOND, prompt: 'first', paused: false, freshContext: false },
        { cron: EVERY_SECOND, prompt: 'second', paused: false, freshContext: false },
      ]),
    );
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);

    expect(started).toEqual([{ session: 'alpha', prompt: 'first' }]);
    expect(delivered).toEqual([{ session: 'alpha', text: 'second' }]);
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
    sessions.set('alpha', sessionWith([{ cron: EVERY_SECOND, prompt: 'restart', paused: false, freshContext: false }]));
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(inspected).toBe(1);
    expect(started[0]?.prompt).toBe('restart');
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
      sessionWith([{ cron: EVERY_SECOND, prompt: 'restart', label: 'safe label', paused: false, freshContext: false }]),
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
