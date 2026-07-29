import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StallSentinelRouter } from '../src/core/sentinel.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';
import type { Activity } from '../src/core/types.js';

let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let router: StallSentinelRouter;
let delivered: { session: string; text: string }[];
let operatorMessages: string[];
let autoSessions: Set<string>;
let pausedSessions: Set<string>;
let activeSessions: Set<string>;
let activities: Map<string, Activity>;
let ephemeralSessions: Set<string>;
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
    activityFor: (session) => activities.get(session),
    isEphemeral: (session) => ephemeralSessions.has(session),
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
  activities = new Map([
    ['alpha', 'working'],
    ['beta', 'working'],
    ['watch', 'idle'],
  ]);
  ephemeralSessions = new Set();
  panes = new Map();
  events = new FakeEventPublisher();
  recentMessages = [];
  const alphaPane = await backend.createPane('alpha', 'pane');
  panes.set('alpha', alphaPane.id);
  backend.setPaneContent(alphaPane.id, 'some terminal output\nlast line');
  router = makeRouter('watch');
  router.activateFleetWatch();
});

afterEach(() => {
  router.stop();
  vi.useRealTimers();
});

describe('stall routing', () => {
  it('routes a stall as ONE self-contained message with the truncated last message', async () => {
    runtime.transcripts.set('/tmp/transcript.jsonl', 'I finished the refactor.');
    await router.handleStall('alpha', 'idle', {
      transcriptPath: '/tmp/transcript.jsonl',
      detectedAt: '2026-07-27T07:03:08.123Z',
    });

    expect(delivered.length).toBe(1);
    expect(delivered[0]?.session).toBe('watch');
    expect(delivered[0]?.text).toContain('[Stall] session=alpha kind=idle detected-at=2026-07-27T07:03:08.123Z');
    expect(delivered[0]?.text).toContain('I finished the refactor.');
    expect(events.events).toContainEqual(
      expect.objectContaining({
        type: 'stall',
        session: 'alpha',
        kind: 'idle',
        detectedAt: '2026-07-27T07:03:08.123Z',
        disposition: 'routed',
      }),
    );
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
    expect(delivered[0]?.text).toContain('#42 outbound to beta delivered at 2026-07-26T12:00:01.000Z');
    expect(delivered[0]?.text).toContain('#41 inbound from beta cancelled at 2026-07-26T11:59:02.000Z');
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
    expect(events.events).toContainEqual(
      expect.objectContaining({
        type: 'stall',
        session: 'alpha',
        kind: 'idle',
        disposition: 'ignored-auto-off',
      }),
    );
  });

  it('ignores stalls while paused', async () => {
    pausedSessions.add('alpha');
    await router.handleStall('alpha', 'idle', {});
    expect(delivered).toEqual([]);
    expect(events.events).toContainEqual(
      expect.objectContaining({
        type: 'stall',
        session: 'alpha',
        kind: 'idle',
        disposition: 'ignored-paused',
      }),
    );
  });

  it('reports paused as the mechanical reason when pause and auto-off both apply', async () => {
    pausedSessions.add('alpha');
    autoSessions.delete('alpha');
    await router.handleStall('alpha', 'idle', {});
    expect(events.events).toContainEqual(
      expect.objectContaining({
        type: 'stall',
        session: 'alpha',
        kind: 'idle',
        disposition: 'ignored-paused',
      }),
    );
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
    expect(events.events).toContainEqual(
      expect.objectContaining({
        type: 'stall',
        session: 'alpha',
        kind: 'idle',
        disposition: 'suppressed',
      }),
    );
  });

  it('never suppresses a new stall kind merely because pane content is similar', async () => {
    await router.handleStall('alpha', 'idle', {});
    await router.handleStall('alpha', 'compaction', {});

    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.text).toContain('kind=compaction');
    expect(events.events).not.toContainEqual(
      expect.objectContaining({ type: 'stall', kind: 'compaction', disposition: 'suppressed' }),
    );
  });

  it('does not carry duplicate suppression across session runs', async () => {
    await router.handleStall('alpha', 'idle', {});
    router.reset('alpha');
    await router.handleStall('alpha', 'idle', {});
    expect(delivered.length).toBe(2);
  });

  it('reports stalls plainly to the operator when no sentinel is configured', async () => {
    router = makeRouter(undefined);
    await router.handleStall('alpha', 'blocked', {
      reason: 'permission prompt',
      detectedAt: '2026-07-27T07:03:08.123Z',
    });
    expect(operatorMessages.length).toBe(1);
    expect(operatorMessages[0]).toContain('alpha stalled (blocked) at 2026-07-27T07:03:08.123Z');
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

describe('sentinel liveness', () => {
  it('reports the watcher\u2019s own failure without waiting for a stall to need routing', async () => {
    // Fleet watch excludes the sentinel by design, so nothing else observes the
    // one seat whose failure disables all stall routing.
    activeSessions.delete('watch');

    await router.checkSentinelHealth();

    expect(operatorMessages).toHaveLength(1);
    expect(operatorMessages[0]).toContain('Sentinel watch is not running');
    expect(delivered).toEqual([]);
  });

  it('rate-limits the alarm and announces recovery once', async () => {
    activeSessions.delete('watch');
    await router.checkSentinelHealth();
    await router.checkSentinelHealth();
    expect(operatorMessages).toHaveLength(1);

    activeSessions.add('watch');
    await router.checkSentinelHealth();
    await router.checkSentinelHealth();

    expect(operatorMessages).toHaveLength(2);
    expect(operatorMessages[1]).toContain('running again');
  });

  it('treats an inconclusive liveness inspection as unknown, not failure', async () => {
    router = makeRouter('watch', () => {
      throw new Error('terminal inspection failed');
    });

    await router.checkSentinelHealth();

    expect(operatorMessages).toEqual([]);
  });

  it('says nothing when no sentinel is designated', async () => {
    router = makeRouter(undefined);
    await router.checkSentinelHealth();
    expect(operatorMessages).toEqual([]);
  });
});

describe('fleet stall watch', () => {
  it('routes one fleet alert only after every non-sentinel session is non-working', async () => {
    expect(router.toggleFleetWatch()).toBe(true);

    activities.set('alpha', 'idle');
    await router.handleStall('alpha', 'idle', {});
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);

    activities.set('beta', 'idle');
    await router.handleStall('beta', 'idle', {});
    await Promise.resolve();
    const fleet = delivered.filter((item) => item.text.startsWith('[Fleet Stall]'));
    expect(fleet).toHaveLength(1);
    expect(fleet[0]?.session).toBe('watch');
    expect(fleet[0]?.text).toMatch(
      /^\[Fleet Stall\] sessions=alpha,beta all-nonworking-for=0s detected-at=\d{4}-\d{2}-\d{2}T.*Z Investigate immediately\.$/u,
    );
  });

  it('cancels confirmation when one member recovers, then rearms for a later fleet stall', async () => {
    vi.useFakeTimers();
    router = makeRouter('watch', undefined, 30);
    router.activateFleetWatch();
    router.toggleFleetWatch();
    activities.set('alpha', 'idle');
    await router.handleStall('alpha', 'idle', {});
    activities.set('beta', 'idle');
    await router.handleStall('beta', 'idle', {});

    activities.set('alpha', 'working');
    router.noteWorking('alpha');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);

    activities.set('alpha', 'idle');
    await router.handleStall('alpha', 'idle', {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(delivered.filter((item) => item.text.startsWith('[Fleet Stall]'))).toHaveLength(1);
  });

  it('does not restart fleet confirmation when auto or pause routing policy changes', async () => {
    vi.useFakeTimers();
    router = makeRouter('watch', undefined, 30);
    router.activateFleetWatch();
    router.toggleFleetWatch();
    activities.set('alpha', 'idle');
    activities.set('beta', 'idle');
    await router.handleStall('alpha', 'idle', {});

    await vi.advanceTimersByTimeAsync(10_000);
    router.resetRouting('alpha'); // canonical auto/pause operations use this path
    await vi.advanceTimersByTimeAsync(20_000);

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
      activityFor: (session) => activities.get(session),
      isEphemeral: (session) => ephemeralSessions.has(session),
      isEphemeral: (session) => ephemeralSessions.has(session),
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
    activities.set('gamma', 'working');
    router.setRegisteredSessions(['alpha', 'beta', 'gamma', 'watch']);
    router.toggleFleetWatch();
    activities.set('alpha', 'idle');
    await router.handleStall('alpha', 'idle', {});
    activities.set('beta', 'idle');
    await router.handleStall('beta', 'idle', {});
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);

    router.setRegisteredSessions(['alpha', 'beta', 'watch']);
    await Promise.resolve();

    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(true);
    expect(router.isFleetWatchEnabled()).toBe(true);
  });

  it('counts stopped registrations as non-working fleet members', async () => {
    activities.set('beta', 'stopped');
    activeSessions.add('gamma');
    activities.set('gamma', 'working');
    router.setRegisteredSessions(['alpha', 'beta', 'gamma', 'watch']);
    router.toggleFleetWatch();

    activities.set('alpha', 'idle');
    await router.handleStall('alpha', 'idle', {});
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);

    activities.set('gamma', 'idle');
    await router.handleStall('gamma', 'idle', {});
    await Promise.resolve();

    const fleet = delivered.filter((item) => item.text.startsWith('[Fleet Stall]'));
    expect(fleet).toHaveLength(1);
    expect(fleet[0]?.text).toContain('sessions=alpha,beta,gamma');
  });

  it('does not restate one session\u2019s idle stall as a campaign-level alert', async () => {
    // With a single running standing member, "nobody is working" says exactly
    // what that member's own idle stall already said. The sentinel would get the
    // same fact twice, dressed as a fleet emergency.
    router.setRegisteredSessions(['alpha', 'watch']);
    router.toggleFleetWatch();
    activities.set('alpha', 'idle');
    router.reset('alpha');
    await Promise.resolve();

    expect(router.isFleetWatchEnabled()).toBe(true);
    expect(delivered.filter((item) => item.text.startsWith('[Fleet Stall]'))).toHaveLength(0);
    const status = router.fleetWatchStatus();
    expect(status.state).toBe('suppressed');
    expect(status.reason).toContain('quorum unmet');
  });

  it('measures the standing fleet only, so a burst of pods cannot disarm it', async () => {
    // spawn_session registers its pods, and with continuous lanes something is
    // always working \u2014 an unscoped roster then cannot fire while still
    // reporting itself armed.
    ephemeralSessions.add('pod-1');
    activeSessions.add('pod-1');
    activities.set('pod-1', 'working');
    router.setRegisteredSessions(['alpha', 'beta', 'pod-1', 'watch']);
    router.toggleFleetWatch();

    activities.set('alpha', 'idle');
    await router.handleStall('alpha', 'idle', {});
    activities.set('beta', 'idle');
    await router.handleStall('beta', 'idle', {});
    await Promise.resolve();

    const fleet = delivered.filter((item) => item.text.startsWith('[Fleet Stall]'));
    expect(fleet).toHaveLength(1);
    expect(fleet[0]?.text).toContain('sessions=alpha,beta');
    expect(fleet[0]?.text).not.toContain('pod-1');
  });

  it('raises a distinct alert when the whole standing fleet goes down', async () => {
    // A stopped session emits no stalls, so nothing else in the system can
    // report this. Suppressing it behind the stall quorum would leave a fleet
    // that died overnight covered by a true sentence in a status report nobody
    // is reading at 4am.
    router.toggleFleetWatch();
    activities.set('alpha', 'idle');
    activities.set('beta', 'idle');
    router.reset('alpha');
    await Promise.resolve();
    expect(delivered.filter((item) => item.text.startsWith('[Fleet Down]'))).toHaveLength(0);

    activities.set('alpha', 'stopped');
    activities.set('beta', 'stopped');
    router.reset('alpha');
    await Promise.resolve();

    const down = delivered.filter((item) => item.text.startsWith('[Fleet Down]'));
    expect(down).toHaveLength(1);
    expect(down[0]?.session).toBe('watch');
    expect(down[0]?.text).toMatch(
      /^\[Fleet Down\] sessions=alpha,beta none-running-for=0s detected-at=\d{4}-\d{2}-\d{2}T.*No standing session is running/u,
    );

    // Latched: repeated lifecycle boundaries while still down do not re-alert.
    router.reset('beta');
    await Promise.resolve();
    expect(delivered.filter((item) => item.text.startsWith('[Fleet Down]'))).toHaveLength(1);
  });

  it('does not call a fleet that never came up an outage', async () => {
    // Starting Conductor with nothing running is not a fleet going dark.
    activities.set('alpha', 'stopped');
    activities.set('beta', 'stopped');
    router = makeRouter('watch');
    router.activateFleetWatch();
    router.toggleFleetWatch();
    await Promise.resolve();

    expect(delivered.filter((item) => item.text.startsWith('[Fleet Down]'))).toHaveLength(0);
    const status = router.fleetWatchStatus();
    expect(status.state).toBe('suppressed');
    expect(status.covers).toEqual([]);
    expect(status.reason).toContain('never came up');
  });

  it('rearms the outage alert once the fleet is back up', async () => {
    router.toggleFleetWatch();
    activities.set('alpha', 'stopped');
    activities.set('beta', 'stopped');
    router.reset('alpha');
    await Promise.resolve();
    expect(delivered.filter((item) => item.text.startsWith('[Fleet Down]'))).toHaveLength(1);

    activities.set('alpha', 'working');
    router.noteWorking('alpha');
    expect(router.fleetWatchStatus().covers).toEqual([]);

    activities.set('alpha', 'stopped');
    router.reset('alpha');
    await Promise.resolve();
    expect(delivered.filter((item) => item.text.startsWith('[Fleet Down]'))).toHaveLength(2);
  });

  it('states which signal it is armed for when only the outage alert can fire', async () => {
    router.toggleFleetWatch();
    activities.set('alpha', 'working');
    router.noteWorking('alpha');
    activities.set('alpha', 'stopped');
    activities.set('beta', 'stopped');
    const status = router.fleetWatchStatus();

    expect(status.state).toBe('armed');
    expect(status.covers).toEqual(['fleet-down']);
  });

  it('reports itself inert rather than armed when only pods are registered', () => {
    ephemeralSessions.add('pod-1');
    router.setRegisteredSessions(['pod-1', 'watch']);
    router.toggleFleetWatch();

    const status = router.fleetWatchStatus();
    expect(status.enabled).toBe(true);
    expect(status.state).toBe('inert');
    expect(status.reason).toContain('no standing sessions are registered');
    expect(status.members).toEqual([]);
  });

  it('reports armed only when it can actually fire', () => {
    router.toggleFleetWatch();
    const status = router.fleetWatchStatus();
    expect(status.state).toBe('armed');
    expect(status.reason).toBeUndefined();
    expect(status.members).toEqual(['alpha', 'beta']);
    expect(status.runningMembers).toEqual(['alpha', 'beta']);
    expect(status.covers).toEqual(['fleet-stall']);
    expect(router.fleetWatchStatus().state).toBe('armed');
    router.toggleFleetWatch();
    expect(router.fleetWatchStatus().state).toBe('off');
  });

  it('stays enabled without alerting when no non-sentinel sessions are registered', async () => {
    router.setRegisteredSessions(['watch']);
    router.toggleFleetWatch();
    await router.handleStall('alpha', 'idle', {});

    expect(router.isFleetWatchEnabled()).toBe(true);
    expect(delivered.some((item) => item.text.startsWith('[Fleet Stall]'))).toBe(false);
  });

  it('does not evaluate a persisted threshold-zero watch until startup reconciliation activates it', async () => {
    activities.set('alpha', 'idle');
    activities.set('beta', 'idle');
    router.stop();
    router = new StallSentinelRouter({
      config: {
        captureLines: 40,
        suppressWindowMs: 300_000,
        suppressSimilarity: 0.8,
        sentinelCodename: 'watch',
        fleetStallThresholdSeconds: 0,
      },
      backend,
      runtimeFor: () => runtime,
      getPane: () => undefined,
      isAuto: () => false,
      isPaused: () => false,
      activityFor: (session) => activities.get(session),
      isEphemeral: (session) => ephemeralSessions.has(session),
      isEphemeral: (session) => ephemeralSessions.has(session),
      isActive: () => true,
      deliver: async (session, text) => delivered.push({ session, text }),
      notifyOperator: async (text) => operatorMessages.push(text),
      logEvent: () => undefined,
      initialFleetWatchEnabled: true,
      initialSessions: ['alpha', 'beta', 'watch'],
    });

    await Promise.resolve();
    expect(delivered).toEqual([]);
    router.activateFleetWatch();
    await Promise.resolve();
    expect(delivered.filter((item) => item.text.startsWith('[Fleet Stall]'))).toHaveLength(1);
  });

  it('ignores auto and pause settings when evaluating fleet-wide non-working state', async () => {
    autoSessions.clear();
    pausedSessions.add('alpha');
    activities.set('alpha', 'idle');
    activities.set('beta', 'idle');
    router.toggleFleetWatch();
    await Promise.resolve();

    expect(delivered.filter((item) => item.text.startsWith('[Fleet Stall]'))).toHaveLength(1);
  });

  it('excludes whichever session is currently designated sentinel', async () => {
    router.toggleFleetWatch();
    router.setSentinel('alpha');
    activities.set('beta', 'idle');
    await router.handleStall('beta', 'idle', {});
    activities.set('watch', 'idle');
    await router.handleStall('watch', 'idle', {});
    await Promise.resolve();

    const fleet = delivered.filter((item) => item.text.startsWith('[Fleet Stall]'));
    expect(fleet).toHaveLength(1);
    expect(fleet[0]?.session).toBe('alpha');
    expect(fleet[0]?.text).toContain('sessions=beta,watch');
  });
});
