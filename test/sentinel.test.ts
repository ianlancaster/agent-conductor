import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StallSentinelRouter } from '../src/core/sentinel.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';

let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let router: StallSentinelRouter;
let delivered: { session: string; text: string }[];
let operatorMessages: string[];
let autoSessions: Set<string>;
let pausedSessions: Set<string>;
let activeSessions: Set<string>;
let panes: Map<string, string>;
let events: FakeEventPublisher;
let recentMessages: {
  id: number;
  sender: string;
  recipient: string;
  status: 'pending' | 'delivered' | 'cancelled';
  created_at: string;
  delivered_at: string | null;
  cancelled_at: string | null;
}[];

function makeRouter(
  sentinelCodename: string | undefined,
  isActive: (session: string) => boolean | Promise<boolean> = (session) => activeSessions.has(session),
  fleetStallThresholdSeconds = 0,
): StallSentinelRouter {
  return new StallSentinelRouter({
    config: {
      captureLines: 40,
      suppressWindowMs: 300_000,
      suppressSimilarity: 0.8,
      sentinelCodename,
      fleetStallThresholdSeconds,
    },
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => {
      const id = panes.get(session);
      return id !== undefined ? { backend: 'fake', id } : undefined;
    },
    isAuto: (session) => autoSessions.has(session),
    isPaused: (session) => pausedSessions.has(session),
    isRunning: (session) => activeSessions.has(session),
    isActive,
    deliver: async (session, text) => {
      delivered.push({ session, text });
      return 'delivered';
    },
    notifyOperator: async (text) => {
      operatorMessages.push(text);
    },
    logEvent: () => undefined,
    recentMessages: () => recentMessages,
    initialSessions: ['alpha', 'beta', 'watch'],
    events,
  });
}

beforeEach(async () => {
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  delivered = [];
  operatorMessages = [];
  autoSessions = new Set(['alpha', 'beta', 'watch']);
  pausedSessions = new Set();
  activeSessions = new Set(['alpha', 'beta', 'watch']);
  panes = new Map();
  events = new FakeEventPublisher();
  recentMessages = [];
  const alphaPane = await backend.createPane('alpha', 'pane');
  panes.set('alpha', alphaPane.id);
  backend.setPaneContent(alphaPane.id, 'some terminal output\nlast line');
  router = makeRouter('watch');
});

afterEach(() => {
  router.stop();
  vi.useRealTimers();
});

describe('stall routing', () => {
  it('routes a stall as ONE self-contained message with the truncated last message', async () => {
    runtime.transcripts.set('/tmp/transcript.jsonl', 'I finished the refactor.');
    await router.handleStall('alpha', 'idle', { transcriptPath: '/tmp/transcript.jsonl' });

    expect(delivered.length).toBe(1);
    expect(delivered[0]?.session).toBe('watch');
    expect(delivered[0]?.text).toContain('[Stall] session=alpha kind=idle');
    expect(delivered[0]?.text).toContain('I finished the refactor.');
    // No follow-up tool calls required: the message IS the whole surface.
    expect(delivered[0]?.text).not.toContain('get_stall_queue');
    expect(delivered[0]?.text).not.toContain('resolve_stall');
  });

  it('adds a bounded content-free communication ledger to the stall payload', async () => {
    recentMessages = [
      {
        id: 42,
        sender: 'alpha',
        recipient: 'beta',
        status: 'delivered',
        created_at: '2026-07-26 12:00:00',
        delivered_at: '2026-07-26 12:00:01',
        cancelled_at: null,
      },
      {
        id: 41,
        sender: 'beta',
        recipient: 'alpha',
        status: 'cancelled',
        created_at: '2026-07-26 11:59:00',
        delivered_at: null,
        cancelled_at: '2026-07-26 11:59:02',
      },
    ];
    await router.handleStall('alpha', 'idle', { reason: 'waiting' });

    expect(delivered[0]?.text).toContain('recent conductor messages:');
    expect(delivered[0]?.text).toContain('#42 outbound to beta delivered at 2026-07-26 12:00:01');
    expect(delivered[0]?.text).toContain('#41 inbound from beta cancelled at 2026-07-26 11:59:02');
  });

  it('falls back to the stall reason, then a placeholder, when no transcript is available', async () => {
    await router.handleStall('alpha', 'blocked', { reason: 'permission prompt' });
    expect(delivered[0]?.text).toContain('permission prompt');

    backend.setPaneContent(panes.get('alpha') ?? '', 'entirely new pane content');
    await router.handleStall('alpha', 'silent', {});
    expect(delivered[1]?.text).toContain('(no last message available)');
  });

  it('truncates a huge last message', async () => {
    runtime.transcripts.set('/tmp/t.jsonl', 'x'.repeat(5000));
    await router.handleStall('alpha', 'idle', { transcriptPath: '/tmp/t.jsonl' });
    expect((delivered[0]?.text ?? '').length).toBeLessThan(600);
  });

  it('ignores stalls when auto is off', async () => {
    autoSessions.delete('alpha');
    await router.handleStall('alpha', 'idle', {});
    expect(delivered).toEqual([]);
    expect(events.events).toContainEqual({
      type: 'stall',
      session: 'alpha',
      kind: 'idle',
      disposition: 'ignored-auto-off',
    });
  });

  it('ignores stalls while paused', async () => {
    pausedSessions.add('alpha');
    await router.handleStall('alpha', 'idle', {});
    expect(delivered).toEqual([]);
    expect(events.events).toContainEqual({
      type: 'stall',
      session: 'alpha',
      kind: 'idle',
      disposition: 'ignored-paused',
    });
  });

  it('reports paused as the mechanical reason when pause and auto-off both apply', async () => {
    pausedSessions.add('alpha');
    autoSessions.delete('alpha');
    await router.handleStall('alpha', 'idle', {});
    expect(events.events).toContainEqual({
      type: 'stall',
      session: 'alpha',
      kind: 'idle',
      disposition: 'ignored-paused',
    });
    expect(events.events).not.toContainEqual(expect.objectContaining({ disposition: 'ignored-auto-off' }));
  });

  it("ignores the sentinel's own stalls — idle is its normal state, not an emergency", async () => {
    await router.handleStall('watch', 'idle', {});
    await router.handleStall('watch', 'silent', {});
    expect(operatorMessages).toEqual([]);
    expect(delivered).toEqual([]);
    expect(events.events).toEqual([]);
  });

  it('suppresses a repeat stall with similar pane content', async () => {
    await router.handleStall('alpha', 'idle', {});
    await router.handleStall('alpha', 'idle', {});
    expect(delivered.length).toBe(1);
    expect(events.events).toContainEqual({
      type: 'stall',
      session: 'alpha',
      kind: 'idle',
      disposition: 'suppressed',
    });
  });

  it('does not carry duplicate suppression across session runs', async () => {
    await router.handleStall('alpha', 'idle', {});
    router.reset('alpha');
    await router.handleStall('alpha', 'idle', {});
    expect(delivered.length).toBe(2);
  });

  it('reports stalls plainly to the operator when no sentinel is configured', async () => {
    router = makeRouter(undefined);
    await router.handleStall('alpha', 'blocked', { reason: 'permission prompt' });
    expect(operatorMessages.length).toBe(1);
    expect(operatorMessages[0]).toContain('alpha stalled (blocked)');
    expect(operatorMessages[0]).toContain('permission prompt');
    // No preaching about configuring one.
    expect(operatorMessages[0]).not.toContain('sentinel');
    // Every distinct stall is reported — these are real reports, not nags.
    backend.setPaneContent(panes.get('alpha') ?? '', 'completely different content now');
    await router.handleStall('alpha', 'idle', {});
    expect(operatorMessages.length).toBe(2);
  });

  it('warns (rate-limited) when the sentinel is configured but not running', async () => {
    activeSessions.delete('watch');
    await router.handleStall('alpha', 'idle', {});
    expect(operatorMessages[0]).toContain('sentinel watch is not running');
    expect(delivered).toEqual([]);
    // Second distinct stall inside the warn window: not re-warned.
    backend.setPaneContent(panes.get('alpha') ?? '', 'completely different content now');
    await router.handleStall('alpha', 'blocked', {});
    expect(operatorMessages.length).toBe(1);
  });

  it('awaits an authoritative liveness refresh before declaring the sentinel down', async () => {
    activeSessions.delete('watch'); // stale cached state
    let refreshed = false;
    router = makeRouter('watch', async (session) => {
      expect(session).toBe('watch');
      refreshed = true;
      return true; // terminal inspection found the runtime alive
    });

    await router.handleStall('alpha', 'idle', {});
    expect(refreshed).toBe(true);
    expect(delivered[0]?.session).toBe('watch');
    expect(operatorMessages).toEqual([]);
  });
});

describe('isSentinel', () => {
  it('gates by exact codename', () => {
    expect(router.isSentinel('watch')).toBe(true);
    expect(router.isSentinel('alpha')).toBe(false);
    expect(makeRouter(undefined).isSentinel('watch')).toBe(false);
  });

  it('reflects designation changes immediately', () => {
    router.setSentinel('alpha');
    expect(router.sentinelCodename()).toBe('alpha');
    expect(router.isSentinel('alpha')).toBe(true);
    expect(router.isSentinel('watch')).toBe(false);

    router.setSentinel(undefined);
    expect(router.sentinelCodename()).toBeUndefined();
    expect(router.isSentinel('alpha')).toBe(false);
  });
});

describe('fleet stall watch', () => {
  it('routes one fleet alert only after every non-sentinel session has stalled', async () => {
    expect(router.toggleFleetWatch()).toBe(true);

    await router.handleStall('alpha', 'idle', {});
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);

    await router.handleStall('beta', 'idle', {});
    await Promise.resolve();
    const fleet = delivered.filter((item) => item.text.startsWith('[Fleet Stall]'));
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toEqual({
      session: 'watch',
      text: '[Fleet Stall] sessions=alpha,beta all-stalled-for=0s Investigate immediately.',
    });
  });

  it('cancels confirmation when one member recovers, then rearms for a later fleet stall', async () => {
    vi.useFakeTimers();
    router = makeRouter('watch', undefined, 30);
    router.toggleFleetWatch();
    await router.handleStall('alpha', 'idle', {});
    await router.handleStall('beta', 'idle', {});

    router.noteWorking('alpha');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);

    await router.handleStall('alpha', 'idle', {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(delivered.filter((item) => item.text.startsWith('[Fleet Stall]'))).toHaveLength(1);
  });

  it('toggles one fleet-wide setting and persists only through its callback', () => {
    const changes: boolean[] = [];
    router = new StallSentinelRouter({
      config: {
        captureLines: 40,
        suppressWindowMs: 300_000,
        suppressSimilarity: 0.8,
        sentinelCodename: 'watch',
        fleetStallThresholdSeconds: 15,
      },
      backend,
      runtimeFor: () => runtime,
      getPane: () => undefined,
      isAuto: () => false,
      isPaused: () => false,
      isRunning: (session) => activeSessions.has(session),
      isActive: () => true,
      deliver: async () => undefined,
      notifyOperator: async () => undefined,
      logEvent: () => undefined,
      initialSessions: ['alpha', 'beta', 'watch'],
      onFleetWatchChanged: (enabled) => changes.push(enabled),
    });

    expect(router.isFleetWatchEnabled()).toBe(false);
    expect(router.toggleFleetWatch()).toBe(true);
    expect(router.toggleFleetWatch()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('tracks registered membership automatically', async () => {
    activeSessions.add('gamma');
    router.setRegisteredSessions(['alpha', 'beta', 'gamma', 'watch']);
    router.toggleFleetWatch();
    await router.handleStall('alpha', 'idle', {});
    await router.handleStall('beta', 'idle', {});
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);

    router.setRegisteredSessions(['alpha', 'beta', 'watch']);
    await Promise.resolve();

    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(true);
    expect(router.isFleetWatchEnabled()).toBe(true);
  });

  it('ignores stopped registrations and keeps watching the active fleet', async () => {
    activeSessions.delete('beta');
    activeSessions.add('gamma');
    router.setRegisteredSessions(['alpha', 'beta', 'gamma', 'watch']);
    router.toggleFleetWatch();

    await router.handleStall('alpha', 'idle', {});
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);

    await router.handleStall('gamma', 'idle', {});
    await Promise.resolve();

    const fleet = delivered.filter((item) => item.text.startsWith('[Fleet Stall]'));
    expect(fleet).toHaveLength(1);
    expect(fleet[0]?.text).toContain('sessions=alpha,gamma');
    expect(fleet[0]?.text).not.toContain('beta');
  });

  it('stays enabled without alerting when fewer than two sessions are eligible', async () => {
    router.setRegisteredSessions(['alpha', 'watch']);
    router.toggleFleetWatch();
    await router.handleStall('alpha', 'idle', {});

    expect(router.isFleetWatchEnabled()).toBe(true);
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);
  });

  it('excludes whichever session is currently designated sentinel', async () => {
    router.toggleFleetWatch();
    router.setSentinel('alpha');
    await router.handleStall('beta', 'idle', {});
    await router.handleStall('watch', 'idle', {});
    await Promise.resolve();

    const fleet = delivered.filter((item) => item.text.startsWith('[Fleet Stall]'));
    expect(fleet).toHaveLength(1);
    expect(fleet[0]?.session).toBe('alpha');
    expect(fleet[0]?.text).toContain('sessions=beta,watch');
  });
});
