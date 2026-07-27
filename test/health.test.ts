import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthMonitor } from '../src/core/health.js';
import type { StallKind } from '../src/core/types.js';
import { CodexRuntime } from '../src/runtimes/codex/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

const CONFIG = { captureLines: 40, stallBeatsThreshold: 2, idleConfirmMs: 15_000, eventSilenceMs: 120_000 };

interface Recorded {
  session: string;
  kind: StallKind;
  reason?: string;
}

let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let monitor: HealthMonitor;
let stalls: Recorded[];
let stallDetections: string[];
let sessionEnds: string[];
let working: string[];
let observed: string[];
let paneId: string;
let paneActivity: 'working' | 'idle';

beforeEach(async () => {
  vi.useFakeTimers();
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  const pane = await backend.createPane('alpha', 'pane');
  paneId = pane.id;
  backend.panes.get(paneId)!.sessionActive = true;
  stalls = [];
  stallDetections = [];
  sessionEnds = [];
  working = [];
  observed = [];
  paneActivity = 'idle';
  monitor = new HealthMonitor({
    config: CONFIG,
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => (session === 'alpha' ? { backend: 'fake', id: paneId } : undefined),
    getActiveSessions: () => ['alpha'],
    onRuntimeObserved: (session) => observed.push(session),
    activityForPane: async () => paneActivity,
    onStall: (session, kind, info) => {
      stalls.push({ session, kind, reason: info.reason });
      if (info.detectedAt !== undefined) stallDetections.push(info.detectedAt);
    },
    onWorking: (session) => working.push(session),
    onSessionEnd: (session) => sessionEnds.push(session),
    logEvent: () => undefined,
  });
});

afterEach(() => {
  monitor.stop();
  vi.useRealTimers();
});

function event(
  type: 'turn-start' | 'stop' | 'notification' | 'compaction' | 'compaction-complete' | 'session-start' | 'session-end',
  reason?: string,
  turnId?: string,
): void {
  monitor.handleEvent({ session: 'alpha', type, reason, turnId, receivedAt: Date.now() });
}

describe('event-driven signals', () => {
  it('turns a stop event into an idle stall after the quiet period without losing its message', () => {
    vi.setSystemTime(new Date('2026-07-27T07:00:00.000Z'));
    event('stop', 'All tests passed.');
    expect(stalls).toEqual([]);
    vi.advanceTimersByTime(CONFIG.idleConfirmMs + 1);
    expect(stalls).toEqual([{ session: 'alpha', kind: 'idle', reason: 'All tests passed.' }]);
    expect(stallDetections).toEqual(['2026-07-27T07:00:15.000Z']);
  });

  it('cancels the idle timer when another event arrives (session got new work)', () => {
    event('stop');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs / 2);
    event('session-start');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs * 2);
    expect(stalls).toEqual([]);
  });

  it('ignores an out-of-order completion for an older runtime turn', () => {
    event('turn-start', undefined, 'turn-1');
    event('turn-start', undefined, 'turn-2');
    event('stop', 'older done', 'turn-1');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs * 2);
    expect(stalls).toEqual([]);

    event('stop', 'current done', 'turn-2');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs + 1);
    expect(stalls).toEqual([{ session: 'alpha', kind: 'idle', reason: 'current done' }]);
  });

  it('rejects a stale identified completion while newer conductor-submitted work awaits its turn id', () => {
    event('turn-start', undefined, 'turn-1');
    monitor.markTurnActive('alpha');
    event('stop', 'older done', 'turn-1');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs * 2);
    expect(stalls).toEqual([]);
  });

  it('preserves a turn id reported between submission and terminal acknowledgement', () => {
    event('turn-start', undefined, 'turn-1');
    const boundary = monitor.captureTurnBoundary();
    event('turn-start', undefined, 'turn-2');
    monitor.markTurnActive('alpha', boundary);

    event('stop', 'current done', 'turn-2');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs + 1);
    expect(stalls).toEqual([{ session: 'alpha', kind: 'idle', reason: 'current done' }]);
  });

  it('does not resurrect a turn completed before terminal acknowledgement', () => {
    const boundary = monitor.captureTurnBoundary();
    event('turn-start', undefined, 'turn-2');
    event('stop', 'fast turn done', 'turn-2');

    expect(monitor.markTurnActive('alpha', boundary)).toBe(false);
    vi.advanceTimersByTime(CONFIG.idleConfirmMs + 1);
    expect(stalls).toEqual([{ session: 'alpha', kind: 'idle', reason: 'fast turn done' }]);
    expect(working).toEqual(['alpha']);
  });

  it('marks direct operator input as working and cancels a stale idle transition', () => {
    event('stop');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs / 2);
    event('turn-start');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs * 2);
    expect(stalls).toEqual([]);
    expect(working).toEqual(['alpha']);
  });

  it('uses an authoritative turn-start as positive work evidence during the idle debounce', async () => {
    backend.setPaneContent(paneId, 'completed output');
    await monitor.heartbeat(); // establish the idle pane baseline
    event('stop');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs / 2);
    event('turn-start');
    backend.setPaneContent(paneId, 'new operator prompt\n• Working');
    await monitor.heartbeat();
    vi.advanceTimersByTime(CONFIG.idleConfirmMs * 2);

    expect(working).toEqual(['alpha']);
    expect(stalls).toEqual([]);
  });

  it('does not mistake a final pane redraw after authoritative completion for a new turn', async () => {
    backend.setPaneContent(paneId, 'last assistant text');
    await monitor.heartbeat();
    event('stop', 'done');
    backend.setPaneContent(paneId, 'last assistant text\n› prompt');
    await monitor.heartbeat();
    vi.advanceTimersByTime(CONFIG.idleConfirmMs + 1);

    expect(working).toEqual([]);
    expect(stalls).toEqual([{ session: 'alpha', kind: 'idle', reason: 'done' }]);
  });

  it('raises blocked stalls immediately on notification events', () => {
    event('notification', 'needs permission');
    expect(stalls).toEqual([{ session: 'alpha', kind: 'blocked', reason: 'needs permission' }]);
  });

  it('returns an interrupted authoritative turn to working when pane output resumes', async () => {
    backend.setPaneContent(paneId, 'permission prompt');
    await monitor.heartbeat();
    event('turn-start', undefined, 'turn-1');
    event('notification', 'needs permission', 'turn-1');
    backend.setPaneContent(paneId, 'permission accepted\ncontinuing');
    await monitor.heartbeat();
    event('stop', 'done', 'turn-1');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs + 1);

    expect(working).toEqual(['alpha', 'alpha']);
    expect(stalls).toEqual([
      { session: 'alpha', kind: 'blocked', reason: 'needs permission' },
      { session: 'alpha', kind: 'idle', reason: 'done' },
    ]);
  });

  it('routes compaction only after the completed runtime returns to an idle composer', async () => {
    event('compaction');
    expect(stalls).toEqual([]);

    event('compaction-complete');
    await vi.advanceTimersByTimeAsync(CONFIG.idleConfirmMs + 1);

    expect(stalls).toEqual([{ session: 'alpha', kind: 'compaction', reason: undefined }]);
    expect(working).toEqual([]);
  });

  it('keeps an automatically compacted turn working when no composer is visible', async () => {
    paneActivity = 'working';
    event('compaction');
    event('compaction-complete');

    await vi.advanceTimersByTimeAsync(CONFIG.idleConfirmMs + 1);

    expect(stalls).toEqual([]);
    expect(working).toEqual(['alpha']);
  });

  it('cancels post-compaction routing when a new turn starts during confirmation', async () => {
    event('compaction');
    event('compaction-complete');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs / 2);
    event('turn-start');

    await vi.advanceTimersByTimeAsync(CONFIG.idleConfirmMs * 2);

    expect(stalls).toEqual([]);
    expect(working).toEqual(['alpha']);
  });

  it('does not treat a runtime session boundary as process death', () => {
    event('session-end');
    expect(sessionEnds).toEqual([]);
  });
});

describe('fallback pane-diff watchdog', () => {
  it('reports a live foreground runtime before any lifecycle event arrives', async () => {
    await monitor.heartbeat();
    expect(observed).toEqual(['alpha']);
  });

  it('never converts an authoritative active turn into a silent stall', async () => {
    event('session-start');
    backend.setPaneContent(paneId, 'unchanged');
    vi.advanceTimersByTime(CONFIG.eventSilenceMs * 3);
    await monitor.heartbeat();
    await monitor.heartbeat();
    await monitor.heartbeat();
    await monitor.heartbeat();
    expect(stalls).toEqual([]);
  });

  it('never promotes an authoritative completed turn from idle to silent', async () => {
    event('stop', 'done');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs + 1);
    expect(stalls).toEqual([{ session: 'alpha', kind: 'idle', reason: 'done' }]);
    backend.setPaneContent(paneId, 'completed output');
    vi.advanceTimersByTime(CONFIG.eventSilenceMs * 3);
    await monitor.heartbeat();
    await monitor.heartbeat();
    await monitor.heartbeat();
    expect(stalls).toEqual([{ session: 'alpha', kind: 'idle', reason: 'done' }]);
  });

  it('raises a silent stall only for a runtime without authoritative completion', async () => {
    runtime.capabilities.authoritativeTurnCompletion = false;
    monitor.markTurnActive('alpha');
    vi.advanceTimersByTime(CONFIG.eventSilenceMs + 1);
    backend.setPaneContent(paneId, 'frozen output');
    await monitor.heartbeat(); // snapshot
    await monitor.heartbeat(); // beat 1 unchanged
    await monitor.heartbeat(); // beat 2 unchanged -> threshold
    expect(stalls).toEqual([{ session: 'alpha', kind: 'silent', reason: undefined }]);
    // No repeat notification while content stays frozen.
    await monitor.heartbeat();
    expect(stalls.length).toBe(1);
  });

  it('ignores changing runtime chrome when deciding whether a pane is frozen', async () => {
    runtime.capabilities.lifecycleEvents = false;
    runtime.capabilities.authoritativeTurnCompletion = false;
    const codex = new CodexRuntime({ config: { binary: 'codex', toolTimeoutSec: 600 }, baseDir: '/tmp' });
    runtime.stripChrome = (capture) => codex.stripChrome(capture);

    backend.setPaneContent(paneId, 'Waiting for background terminal\n• Working (1m 00s • esc to interrupt)');
    await monitor.heartbeat(); // normalized snapshot
    vi.advanceTimersByTime(CONFIG.eventSilenceMs + 1);
    backend.setPaneContent(paneId, 'Waiting for background terminal\n• Working (1m 30s • esc to interrupt)');
    await monitor.heartbeat(); // beat 1: only chrome changed
    backend.setPaneContent(paneId, 'Waiting for background terminal\n• Working (2m 00s • esc to interrupt)');
    await monitor.heartbeat(); // beat 2: only chrome changed -> threshold

    expect(stalls).toEqual([{ session: 'alpha', kind: 'silent', reason: undefined }]);
    expect(working).toEqual([]);
  });

  it('resets the counter when pane content changes', async () => {
    const silent = new FakeRuntime();
    silent.capabilities.lifecycleEvents = false;
    silent.capabilities.authoritativeTurnCompletion = false;
    monitor = new HealthMonitor({
      config: CONFIG,
      backend,
      runtimeFor: () => silent,
      getPane: () => ({ backend: 'fake', id: paneId }),
      getActiveSessions: () => ['alpha'],
      onRuntimeObserved: (session) => observed.push(session),
      activityForPane: async () => paneActivity,
      onStall: (session, kind, info) => stalls.push({ session, kind, reason: info.reason }),
      onWorking: (session) => working.push(session),
      onSessionEnd: (session) => sessionEnds.push(session),
      logEvent: () => undefined,
    });
    backend.setPaneContent(paneId, 'a');
    await monitor.heartbeat();
    vi.advanceTimersByTime(CONFIG.eventSilenceMs + 1);
    await monitor.heartbeat();
    backend.setPaneContent(paneId, 'b');
    await monitor.heartbeat();
    expect(stalls).toEqual([]);
  });

  it('detects pane death as session end', async () => {
    event('session-start');
    vi.advanceTimersByTime(CONFIG.eventSilenceMs + 1);
    await backend.kill({ backend: 'fake', id: paneId });
    await monitor.heartbeat();
    expect(sessionEnds).toEqual(['alpha']);
  });

  it('detects an ended runtime while its pane remains alive', async () => {
    backend.endSession(paneId);
    await monitor.heartbeat();
    expect(await backend.isAlive({ backend: 'fake', id: paneId })).toBe(true);
    expect(sessionEnds).toEqual(['alpha']);
  });
});
