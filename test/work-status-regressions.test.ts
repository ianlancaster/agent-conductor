import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/index.js';
import { deriveWorkStatus } from '../src/core/work-status.js';
import { HealthMonitor } from '../src/core/health.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';
import type { PaneActivityEvidence } from '../src/core/types.js';

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});
afterEach(() => {
  store.close();
  vi.useRealTimers();
});
const fleet = 'test';
const working = { state: 'working' as const, work_id: 'TASK', summary: 'Build' };
const waiting = { state: 'waiting' as const, work_id: 'TASK', summary: 'CI', waiting_on: 'CI' };
const blocker = {
  state: 'blocked' as const,
  work_id: 'TASK',
  summary: 'Choose',
  needs_from: 'operator',
  question: 'A or B?',
  recommendation: 'A',
  meanwhile: 'Wait',
  if_no_answer: 'Wait',
};
const thresholds = {
  disagreementMs: 3_600_000,
  staleMs: 14_400_000,
  waitingMs: 14_400_000,
  observationMaxAgeMs: 60_000,
};

it('keeps a key first supplied on an exact duplicate, after subsequent transitions', () => {
  store.workStatus.report(fleet, 'alpha', working, 100);
  store.workStatus.report(fleet, 'alpha', waiting, 200);
  const duplicate = { ...waiting, idempotencyKey: 'retry-duplicate' };
  const receipt = store.workStatus.report(fleet, 'alpha', duplicate, 300);
  store.workStatus.report(fleet, 'alpha', working, 400);
  const retry = store.workStatus.report(fleet, 'alpha', duplicate, 500);
  expect(retry).toMatchObject({ sequence: receipt.sequence, unchanged: true });
  expect(
    store.workStatus
      .events(fleet)
      .filter((e) => e.kind === 'claim')
      .at(-1)?.state,
  ).toBe('working');
});

it('stops blocked time when the operator resolves the blocker', () => {
  store.workStatus.report(fleet, 'alpha', working, 100);
  store.workStatus.report(fleet, 'alpha', blocker, 200);
  store.workStatus.resolve(fleet, 'TASK', 'A', 500);
  const projection = (now: number) =>
    deriveWorkStatus(
      store.workStatus.current(fleet),
      () => ({ processActive: null, activity: 'unknown' }),
      () => false,
      now,
      thresholds,
    );
  expect(projection(900).views[0]?.cumulativeMs.blocked).toBe(300);
  store.workStatus.report(fleet, 'alpha', working, 1000);
  expect(projection(1100).views[0]?.cumulativeMs.blocked).toBe(300);
});

it('does not treat idle observations separated by unknown telemetry as continuous inactivity', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  const backend = new FakeTerminalBackend();
  const runtime = new FakeRuntime();
  const pane = await backend.createPane('alpha', 'pane');
  let activity: PaneActivityEvidence = 'idle';
  const monitor = new HealthMonitor({
    config: { captureLines: 40, stallBeatsThreshold: 2, idleConfirmMs: 15_000, eventSilenceMs: 120_000 },
    backend,
    runtimeFor: () => runtime,
    getPane: () => pane,
    getActiveSessions: () => ['alpha'],
    observeActivity: async () => activity,
    observeInputState: async () => 'clear',
    onRuntimeObserved: vi.fn(),
    onStall: vi.fn(),
    onWorking: vi.fn(),
    onSessionEnd: vi.fn(),
    logEvent: vi.fn(),
  });
  try {
    store.workStatus.report(fleet, 'alpha', working, 100);
    await monitor.reconcileActivity('alpha', pane);
    vi.setSystemTime(3_600_000);
    activity = 'unknown';
    await monitor.reconcileActivity('alpha', pane);
    vi.setSystemTime(18_000_100);
    activity = 'idle';
    await monitor.reconcileActivity('alpha', pane);
    const observed = monitor.activityObservation('alpha')!;
    const projected = deriveWorkStatus(
      store.workStatus.current(fleet),
      () => ({
        processActive: true,
        processObservedAt: Date.now(),
        activity: observed.activity,
        activityObservedAt: observed.observedAt,
        idleSince: observed.since,
      }),
      () => false,
      Date.now(),
      thresholds,
    );
    expect(projected.views[0]).toMatchObject({ liveness: 'idle', disagreement: false, stale: false });
  } finally {
    monitor.stop();
  }
});
