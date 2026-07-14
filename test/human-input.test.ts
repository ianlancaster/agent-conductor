import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelChoice } from '../src/channels/types.js';
import { HumanInputBroker } from '../src/core/human-input.js';
import type { Autonomy } from '../src/core/types.js';

let broker: HumanInputBroker;
let operatorMessages: { text: string; buttons?: ChannelChoice[][] }[];
let delivered: { agent: string; text: string }[];
let autonomies: Map<string, Autonomy>;
let activeAgents: Set<string>;
let sentinel: string | undefined;

beforeEach(() => {
  operatorMessages = [];
  delivered = [];
  autonomies = new Map();
  activeAgents = new Set();
  sentinel = 'watch';
  broker = new HumanInputBroker({
    notifyOperator: async (text, buttons) => {
      operatorMessages.push({ text, buttons });
    },
    sentinelCodename: () => sentinel,
    isActive: (agent) => activeAgents.has(agent),
    getAutonomy: (agent) => autonomies.get(agent) ?? 'facilitated',
    deliver: async (agent, text) => {
      delivered.push({ agent, text });
      return 'delivered';
    },
  });
});

describe('facilitated agents', () => {
  it('routes the question to the operator with option buttons', async () => {
    const answer = broker.request('alpha', 'Deploy to prod?', 'CI is green.', ['yes', 'no']);
    expect(operatorMessages.length).toBe(1);
    expect(operatorMessages[0]?.text).toContain('Deploy to prod?');
    expect(operatorMessages[0]?.buttons?.flat().map((b) => b.label)).toEqual(['yes', 'no']);

    const [pending] = broker.listPending();
    expect(pending?.agent).toBe('alpha');
    const agent = broker.answerByOption(pending?.id ?? 0, 0);
    expect(agent).toBe('alpha');
    expect(await answer).toBe('yes');
    expect(broker.listPending()).toEqual([]);
  });

  it('resolves via free-text answer', async () => {
    const answer = broker.request('alpha', 'Which branch?');
    const [pending] = broker.listPending();
    expect(broker.answer(pending?.id ?? 0, 'release/2.0')).toBe('alpha');
    expect(await answer).toBe('release/2.0');
  });

  it('returns undefined for unknown or already-answered ids', () => {
    expect(broker.answer(42, 'nope')).toBeUndefined();
  });
});

describe('autonomous agents with a live sentinel', () => {
  beforeEach(() => {
    autonomies.set('alpha', 'autonomous');
    activeAgents.add('watch');
  });

  it('routes the question to the sentinel instead of the operator', async () => {
    const answer = broker.request('alpha', 'Which package manager?', undefined, ['pnpm', 'npm']);
    expect(operatorMessages).toEqual([]);
    expect(delivered.length).toBe(1);
    expect(delivered[0]?.agent).toBe('watch');
    expect(delivered[0]?.text).toContain('[HumanInput #');
    expect(delivered[0]?.text).toContain('Which package manager?');

    const [pending] = broker.listPending();
    broker.answer(pending?.id ?? 0, 'pnpm');
    expect(await answer).toBe('pnpm');
  });

  it('falls back to the operator when the sentinel is down', async () => {
    activeAgents.delete('watch');
    void broker.request('alpha', 'Stuck — proceed?');
    expect(operatorMessages.length).toBe(1);
    expect(delivered).toEqual([]);
  });

  it("routes the sentinel's own questions to the operator, never to itself", async () => {
    autonomies.set('watch', 'autonomous');
    void broker.request('watch', 'Should I nudge alpha again?');
    expect(delivered).toEqual([]);
    expect(operatorMessages.length).toBe(1);
  });
});
