import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthMonitor } from '../src/core/health.js';
import type { StallKind } from '../src/core/types.js';
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
let sessionEnds: string[];
let paneId: string;

beforeEach(async () => {
  vi.useFakeTimers();
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  const pane = await backend.createPane('alpha', 'pane');
  paneId = pane.id;
  backend.panes.get(paneId)!.sessionActive = true;
  stalls = [];
  sessionEnds = [];
  monitor = new HealthMonitor({
    config: CONFIG,
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => (session === 'alpha' ? { backend: 'fake', id: paneId } : undefined),
    getActiveSessions: () => ['alpha'],
    onStall: (session, kind, info) => stalls.push({ session, kind, reason: info.reason }),
    onSessionEnd: (session) => sessionEnds.push(session),
    logEvent: () => undefined,
  });
});

afterEach(() => {
  monitor.stop();
  vi.useRealTimers();
});

function event(type: 'stop' | 'notification' | 'compaction' | 'session-start' | 'session-end', reason?: string): void {
  monitor.handleEvent({ session: 'alpha', type, reason, receivedAt: Date.now() });
}

describe('event-driven signals', () => {
  it('turns a stop event into an idle stall after the quiet period without losing its message', () => {
    event('stop', 'All tests passed.');
    expect(stalls).toEqual([]);
    vi.advanceTimersByTime(CONFIG.idleConfirmMs + 1);
    expect(stalls).toEqual([{ session: 'alpha', kind: 'idle', reason: 'All tests passed.' }]);
  });

  it('cancels the idle timer when another event arrives (session got new work)', () => {
    event('stop');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs / 2);
    event('session-start');
    vi.advanceTimersByTime(CONFIG.idleConfirmMs * 2);
    expect(stalls).toEqual([]);
  });

  it('raises blocked stalls immediately on notification events', () => {
    event('notification', 'needs permission');
    expect(stalls).toEqual([{ session: 'alpha', kind: 'blocked', reason: 'needs permission' }]);
  });

  it('raises compaction stalls immediately', () => {
    event('compaction');
    expect(stalls[0]?.kind).toBe('compaction');
  });

  it('does not treat a runtime session boundary as process death', () => {
    event('session-end');
    expect(sessionEnds).toEqual([]);
  });
});

describe('fallback pane-diff watchdog', () => {
  it('skips pane-diffing while events are flowing', async () => {
    event('session-start');
    backend.setPaneContent(paneId, 'unchanged');
    await monitor.heartbeat();
    await monitor.heartbeat();
    await monitor.heartbeat();
    expect(stalls).toEqual([]);
  });

  it('raises a silent stall when events go quiet and the pane freezes', async () => {
    event('session-start');
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

  it('resets the counter when pane content changes', async () => {
    const silent = new FakeRuntime();
    silent.capabilities.lifecycleEvents = false;
    monitor = new HealthMonitor({
      config: CONFIG,
      backend,
      runtimeFor: () => silent,
      getPane: () => ({ backend: 'fake', id: paneId }),
      getActiveSessions: () => ['alpha'],
      onStall: (session, kind, info) => stalls.push({ session, kind, reason: info.reason }),
      onSessionEnd: (session) => sessionEnds.push(session),
      logEvent: () => undefined,
    });
    backend.setPaneContent(paneId, 'a');
    await monitor.heartbeat();
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
