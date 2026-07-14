import { beforeEach, describe, expect, it } from 'vitest';
import { StallSentinelRouter } from '../src/core/sentinel.js';
import type { Autonomy } from '../src/core/types.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let router: StallSentinelRouter;
let delivered: { agent: string; text: string }[];
let operatorMessages: string[];
let autonomies: Map<string, Autonomy>;
let activeAgents: Set<string>;
let panes: Map<string, string>;

function makeRouter(sentinelCodename: string | undefined): StallSentinelRouter {
  return new StallSentinelRouter({
    config: { captureLines: 40, suppressWindowMs: 300_000, suppressSimilarity: 0.8, sentinelCodename },
    backend,
    runtimeFor: () => runtime,
    getPane: (agent) => {
      const id = panes.get(agent);
      return id !== undefined ? { backend: 'fake', id } : undefined;
    },
    getAutonomy: (agent) => autonomies.get(agent) ?? 'facilitated',
    isActive: (agent) => activeAgents.has(agent),
    deliver: async (agent, text) => {
      delivered.push({ agent, text });
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
  activeAgents = new Set(['alpha', 'watch']);
  panes = new Map();
  const alphaPane = await backend.createPane('alpha', 'pane');
  panes.set('alpha', alphaPane.id);
  backend.setPaneContent(alphaPane.id, 'some terminal output\nlast line');
  router = makeRouter('watch');
});

describe('stall routing', () => {
  it('routes an autonomous agent stall to the sentinel with a queue entry', async () => {
    runtime.transcripts.set('/tmp/transcript.jsonl', 'I finished the refactor.');
    await router.handleStall('alpha', 'idle', { transcriptPath: '/tmp/transcript.jsonl' });

    expect(delivered.length).toBe(1);
    expect(delivered[0]?.agent).toBe('watch');
    expect(delivered[0]?.text).toContain('[Stall] agent=alpha kind=idle');

    const queue = router.pendingStalls();
    expect(queue.length).toBe(1);
    expect(queue[0]?.paneCapture).toContain('some terminal output');
    expect(queue[0]?.lastAssistantMessage).toBe('I finished the refactor.');
  });

  it('ignores stalls from facilitated agents', async () => {
    autonomies.set('alpha', 'facilitated');
    await router.handleStall('alpha', 'idle', {});
    expect(delivered).toEqual([]);
    expect(router.pendingStalls()).toEqual([]);
  });

  it('alerts the operator when the sentinel itself stalls', async () => {
    await router.handleStall('watch', 'silent', {});
    expect(operatorMessages[0]).toContain('Sentinel *watch* itself stalled');
    expect(delivered).toEqual([]);
  });

  it('suppresses a repeat stall with similar pane content', async () => {
    await router.handleStall('alpha', 'idle', {});
    await router.handleStall('alpha', 'idle', {});
    expect(router.pendingStalls().length).toBe(1);
    expect(delivered.length).toBe(1);
  });

  it('warns the operator (rate-limited) when no sentinel is configured', async () => {
    router = makeRouter(undefined);
    await router.handleStall('alpha', 'blocked', { reason: 'permission prompt' });
    expect(operatorMessages.length).toBe(1);
    expect(operatorMessages[0]).toContain('no sentinel is configured');
    // Second distinct stall inside the warn window: queued but not re-warned.
    backend.setPaneContent(panes.get('alpha') ?? '', 'completely different content now');
    await router.handleStall('alpha', 'idle', {});
    expect(operatorMessages.length).toBe(1);
    expect(router.pendingStalls().length).toBe(2);
  });

  it('warns when the sentinel is configured but not running', async () => {
    activeAgents.delete('watch');
    await router.handleStall('alpha', 'idle', {});
    expect(operatorMessages[0]).toContain('sentinel *watch* is not running');
  });
});

describe('resolution', () => {
  beforeEach(async () => {
    await router.handleStall('alpha', 'idle', {});
    delivered = [];
  });

  it('nudge types sentinel-prefixed text into the stalled agent', async () => {
    const id = router.pendingStalls()[0]?.id ?? 0;
    const reply = await router.resolve(id, { action: 'nudge', text: 'Fix the failing tests first.' }, 'watch');
    expect(delivered[0]).toEqual({ agent: 'alpha', text: '[Sentinel] Fix the failing tests first.' });
    expect(reply).toContain('alpha');
    expect(router.pendingStalls()).toEqual([]);
  });

  it('suppress dismisses without action', async () => {
    const id = router.pendingStalls()[0]?.id ?? 0;
    await router.resolve(id, { action: 'suppress', note: 'agent legitimately done' }, 'watch');
    expect(delivered).toEqual([]);
    expect(router.pendingStalls()).toEqual([]);
  });

  it('escalate forwards the question to the operator', async () => {
    const id = router.pendingStalls()[0]?.id ?? 0;
    await router.resolve(id, { action: 'escalate', question: 'Should alpha force-push?' }, 'watch');
    expect(operatorMessages[0]).toContain('Should alpha force-push?');
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
