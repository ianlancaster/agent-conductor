import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryOptions } from '../src/core/delivery.js';
import { scheduleOccurrenceId, type ScheduleOccurrenceAdmission } from '../src/core/schedule-occurrences.js';
import { Scheduler } from '../src/core/scheduler.js';
import { Store } from '../src/store/index.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';

const dirs: string[] = [];
const schedulers: Scheduler[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function admission(): ScheduleOccurrenceAdmission {
  const scheduledAt = '2026-09-17T15:00:00.000Z';
  const period = '0 9 * * *';
  const label = 'review';
  return {
    id: scheduleOccurrenceId('alpha', 0, label, period, scheduledAt),
    session: 'alpha',
    scheduleIndex: 0,
    label,
    period,
    scheduledAt,
    timezone: 'America/Denver',
    envelope:
      '[Cron name="review" period="0 9 * * *" scheduled_at="2026-09-17T15:00:00.000Z" timezone="America/Denver"] inspect',
    wakeIfStopped: false,
    freshContext: false,
  };
}

function makeScheduler(
  store: Store,
  deliver: (
    text: string,
    options: Pick<
      DeliveryOptions,
      'pausePolicy' | 'onSubmissionStarted' | 'onSubmissionRejected' | 'onUncertain' | 'onDelivered'
    >,
  ) => Promise<'delivered' | 'uncertain' | 'queued' | 'cancelled' | 'no-pane'>,
  events = new FakeEventPublisher(),
): { scheduler: Scheduler; events: FakeEventPublisher } {
  const scheduler = new Scheduler({
    sessions: () => new Map(),
    isActive: () => true,
    isPaused: () => false,
    startSession: async () => 'started',
    stopSession: async () => 'stopped',
    deliver: async (_session, text, options) => deliver(text, options),
    occurrences: store,
    events,
  });
  schedulers.push(scheduler);
  return { scheduler, events };
}

describe('Scheduler durable occurrence recovery', () => {
  it('replays an admitted occurrence after reopen with its original envelope and identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-schedule-recovery-'));
    dirs.push(dir);
    const dbPath = join(dir, 'conductor.db');
    const beforeRestart = new Store(dbPath);
    beforeRestart.admit(admission());
    beforeRestart.close();

    const reopened = new Store(dbPath);
    stores.push(reopened);
    const delivered: string[] = [];
    const { scheduler, events } = makeScheduler(reopened, async (text, options) => {
      delivered.push(text);
      expect(options.onSubmissionStarted?.()).toBe(true);
      options.onDelivered?.();
      return 'delivered';
    });

    scheduler.rebuild();
    await vi.waitFor(() => expect(delivered).toEqual([admission().envelope]));

    expect(reopened.getScheduleOccurrence(admission().id)).toMatchObject({ state: 'settled', outcome: 'fired' });
    expect(events.events).toContainEqual({
      type: 'schedule',
      session: 'alpha',
      label: 'review',
      scheduledAt: '2026-09-17T15:00:00.000Z',
      timezone: 'America/Denver',
      outcome: 'fired',
    });
  });

  it('keeps proved-no-write rollback replayable and quarantines an unknown effect', async () => {
    const store = new Store(':memory:');
    stores.push(store);
    store.admit(admission());
    let callbacks:
      Pick<DeliveryOptions, 'onSubmissionStarted' | 'onSubmissionRejected' | 'onUncertain' | 'onDelivered'> | undefined;
    const { scheduler, events } = makeScheduler(store, async (_text, options) => {
      callbacks = options;
      return 'queued';
    });

    scheduler.rebuild();
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    expect(callbacks?.onSubmissionStarted?.()).toBe(true);
    expect(store.getScheduleOccurrence(admission().id)?.state).toBe('dispatching');
    expect(callbacks?.onSubmissionRejected?.()).toBe(true);
    expect(store.getScheduleOccurrence(admission().id)?.state).toBe('admitted');

    expect(callbacks?.onSubmissionStarted?.()).toBe(true);
    callbacks?.onUncertain?.('submission-unconfirmed');
    expect(store.getScheduleOccurrence(admission().id)).toMatchObject({ state: 'unknown', outcome: null });
    expect(events.events).toContainEqual(expect.objectContaining({ type: 'schedule', outcome: 'uncertain' }));
  });

  it('never replays a dispatching row left by an interrupted process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-schedule-quarantine-'));
    dirs.push(dir);
    const dbPath = join(dir, 'conductor.db');
    const interrupted = new Store(dbPath);
    interrupted.admit(admission());
    interrupted.markDispatching(admission().id);
    interrupted.close();

    const store = new Store(dbPath);
    stores.push(store);
    const deliver = vi.fn(async () => 'delivered' as const);
    const { scheduler, events } = makeScheduler(store, deliver);

    scheduler.rebuild();
    await Promise.resolve();

    expect(deliver).not.toHaveBeenCalled();
    expect(store.getScheduleOccurrence(admission().id)).toMatchObject({ state: 'unknown', outcome: null });
    expect(events.events).toEqual([
      {
        type: 'schedule',
        session: 'alpha',
        label: 'review',
        scheduledAt: '2026-09-17T15:00:00.000Z',
        timezone: 'America/Denver',
        outcome: 'uncertain',
      },
    ]);
    expect(JSON.stringify(events.events)).not.toContain('inspect');
  });

  it.each([
    { action: 'cancelSession' as const, startResult: 'active-without-prompt' as const, freshContext: false },
    { action: 'rebuild' as const, startResult: 'not-started' as const, freshContext: true },
    { action: 'stop' as const, startResult: 'not-started' as const, freshContext: false },
  ])(
    'honors $action while recovered start resolves $startResult (freshContext=$freshContext)',
    async ({ action, startResult, freshContext }) => {
      const store = new Store(':memory:');
      stores.push(store);
      store.admit({ ...admission(), wakeIfStopped: true, freshContext });
      let finishStart!: (result: 'active-without-prompt' | 'not-started') => void;
      const pendingStart = new Promise<'active-without-prompt' | 'not-started'>((resolve) => {
        finishStart = resolve;
      });
      const startSession = vi.fn(() => pendingStart);
      const deliver = vi.fn(async () => 'delivered' as const);
      const events = new FakeEventPublisher();
      const scheduler = new Scheduler({
        sessions: () => new Map(),
        isActive: () => false,
        isPaused: () => false,
        startSession,
        stopSession: async () => 'stopped',
        deliver,
        occurrences: store,
        events,
      });
      schedulers.push(scheduler);

      scheduler.rebuild();
      await vi.waitFor(() => expect(startSession).toHaveBeenCalledOnce());
      expect(store.getScheduleOccurrence(admission().id)?.state).toBe('dispatching');
      if (action === 'cancelSession') scheduler.cancelSession('alpha');
      else scheduler[action]();
      finishStart(startResult);

      await vi.waitFor(() =>
        expect(store.getScheduleOccurrence(admission().id)).toMatchObject({
          state: 'settled',
          outcome: 'skipped-cancelled',
        }),
      );
      expect(deliver).not.toHaveBeenCalled();
      expect(events.events).toContainEqual(expect.objectContaining({ outcome: 'skipped-cancelled' }));
      expect(events.events).not.toContainEqual(expect.objectContaining({ outcome: 'fired' }));
      expect(events.events).not.toContainEqual(expect.objectContaining({ outcome: 'failed' }));
    },
  );
});
