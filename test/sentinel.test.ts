import { beforeEach, describe, expect, it } from 'vitest';
import { StallSentinelRouter } from '../src/core/sentinel.js';
import type { Autonomy } from '../src/core/types.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let router: StallSentinelRouter;
let delivered: { session: string; text: string }[];
let operatorMessages: string[];
let autonomies: Map<string, Autonomy>;
let activeSessions: Set<string>;
let panes: Map<string, string>;

function makeRouter(sentinelCodename: string | undefined): StallSentinelRouter {
  return new StallSentinelRouter({
    config: { captureLines: 40, suppressWindowMs: 300_000, suppressSimilarity: 0.8, sentinelCodename },
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => {
      const id = panes.get(session);
      return id !== undefined ? { backend: 'fake', id } : undefined;
    },
    getAutonomy: (session) => autonomies.get(session) ?? 'facilitated',
    isActive: (session) => activeSessions.has(session),
    deliver: async (session, text) => {
      delivered.push({ session, text });
      return 'delivered';
    },
    notifyOperator: async (text) => {
      operatorMessages.push(text);
    },
    logEvent: () => undefined,
  });
}

beforeEach(async () => {
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  delivered = [];
  operatorMessages = [];
  autonomies = new Map([
    ['alpha', 'autonomous'],
    ['watch', 'autonomous'],
  ]);
  activeSessions = new Set(['alpha', 'watch']);
  panes = new Map();
  const alphaPane = await backend.createPane('alpha', 'pane');
  panes.set('alpha', alphaPane.id);
  backend.setPaneContent(alphaPane.id, 'some terminal output\nlast line');
  router = makeRouter('watch');
});

describe('stall routing', () => {
  it('routes an autonomous session stall to the sentinel with a queue entry', async () => {
    runtime.transcripts.set('/tmp/transcript.jsonl', 'I finished the refactor.');
    await router.handleStall('alpha', 'idle', { transcriptPath: '/tmp/transcript.jsonl' });

    expect(delivered.length).toBe(1);
    expect(delivered[0]?.session).toBe('watch');
    expect(delivered[0]?.text).toContain('[Stall] session=alpha kind=idle');

    const queue = router.pendingStalls();
    expect(queue.length).toBe(1);
    expect(queue[0]?.paneCapture).toContain('some terminal output');
    expect(queue[0]?.lastAssistantMessage).toBe('I finished the refactor.');
  });

  it('ignores stalls from facilitated sessions', async () => {
    autonomies.set('alpha', 'facilitated');
    await router.handleStall('alpha', 'idle', {});
    expect(delivered).toEqual([]);
    expect(router.pendingStalls()).toEqual([]);
  });

  it("ignores the sentinel's own stalls — idle is its normal state, not an emergency", async () => {
    await router.handleStall('watch', 'idle', {});
    await router.handleStall('watch', 'silent', {});
    expect(operatorMessages).toEqual([]);
    expect(delivered).toEqual([]);
    expect(router.pendingStalls()).toEqual([]);
  });

  it('suppresses a repeat stall with similar pane content', async () => {
    await router.handleStall('alpha', 'idle', {});
    await router.handleStall('alpha', 'idle', {});
    expect(router.pendingStalls().length).toBe(1);
    expect(delivered.length).toBe(1);
  });

  it('reports stalls plainly to the operator when no sentinel is configured', async () => {
    router = makeRouter(undefined);
    await router.handleStall('alpha', 'blocked', { reason: 'permission prompt' });
    expect(operatorMessages.length).toBe(1);
    expect(operatorMessages[0]).toContain('*alpha* stalled (blocked)');
    expect(operatorMessages[0]).toContain('permission prompt');
    // No preaching about configuring one, and no queue nobody will drain.
    expect(operatorMessages[0]).not.toContain('sentinel');
    expect(router.pendingStalls().length).toBe(0);
    // Every distinct stall is reported — these are real reports, not nags.
    backend.setPaneContent(panes.get('alpha') ?? '', 'completely different content now');
    await router.handleStall('alpha', 'idle', {});
    expect(operatorMessages.length).toBe(2);
  });

  it('warns (rate-limited) when the sentinel is configured but not running', async () => {
    activeSessions.delete('watch');
    await router.handleStall('alpha', 'idle', {});
    expect(operatorMessages[0]).toContain('sentinel *watch* is not running');
    expect(router.pendingStalls().length).toBe(1); // queued for the sentinel to drain on start
    // Second distinct stall inside the warn window: queued but not re-warned.
    backend.setPaneContent(panes.get('alpha') ?? '', 'completely different content now');
    await router.handleStall('alpha', 'blocked', {});
    expect(operatorMessages.length).toBe(1);
    expect(router.pendingStalls().length).toBe(2);
  });
});

describe('resolution', () => {
  beforeEach(async () => {
    await router.handleStall('alpha', 'idle', {});
    delivered = [];
  });

  it('nudge types sentinel-prefixed text into the stalled session', async () => {
    const id = router.pendingStalls()[0]?.id ?? 0;
    const reply = await router.resolve(id, { action: 'nudge', text: 'Fix the failing tests first.' }, 'watch');
    expect(delivered[0]).toEqual({ session: 'alpha', text: '[Sentinel] Fix the failing tests first.' });
    expect(reply).toContain('alpha');
    expect(router.pendingStalls()).toEqual([]);
  });

  it('suppress dismisses without action', async () => {
    const id = router.pendingStalls()[0]?.id ?? 0;
    await router.resolve(id, { action: 'suppress', note: 'session legitimately done' }, 'watch');
    expect(delivered).toEqual([]);
    expect(router.pendingStalls()).toEqual([]);
  });

  it('rejects unknown stall ids', async () => {
    expect(await router.resolve(999, { action: 'suppress' }, 'watch')).toContain('No pending stall');
  });
});

describe('isSentinel', () => {
  it('gates by exact codename', () => {
    expect(router.isSentinel('watch')).toBe(true);
    expect(router.isSentinel('alpha')).toBe(false);
    expect(makeRouter(undefined).isSentinel('watch')).toBe(false);
  });
});
