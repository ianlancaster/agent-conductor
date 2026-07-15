import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config/schema.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { HumanInputBroker } from '../src/core/human-input.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Messaging } from '../src/core/messaging.js';
import { StallSentinelRouter } from '../src/core/sentinel.js';
import { AgentStateManager } from '../src/core/state.js';
import { statusReport } from '../src/core/status.js';
import { buildMcpTools } from '../src/mcp/tools.js';
import type { McpToolDefinition } from '../src/mcp/server.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let store: Store;
let states: AgentStateManager;
let agents: Map<string, AgentConfig>;
let tools: McpToolDefinition[];
let sentinelCodename: string | undefined;

function tool(name: string): McpToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

function agentConfig(codename: string): AgentConfig {
  return { codename, repo: `/tmp/${codename}`, runtime: 'claude-code', additionalDirs: [], schedules: [] };
}

beforeEach(() => {
  store = new Store(':memory:');
  const backend = new FakeTerminalBackend();
  const runtime = new FakeRuntime();
  states = new AgentStateManager(store, 'facilitated');
  agents = new Map([
    ['alpha', agentConfig('alpha')],
    ['watch', agentConfig('watch')],
  ]);
  sentinelCodename = 'watch';

  const delivery = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (a) => lifecycle.getPane(a),
    config: { queueDrainMs: 2000, queueMaxAgeMs: 60_000 },
  });
  const lifecycle = new Lifecycle({
    store,
    backend,
    states,
    runtimes: new Map([['claude-code', runtime]]),
    agents: () => agents,
    identityFor: (c) => ({ mcpUrl: '', eventsUrl: '', configDir: `/tmp/${c}` }),
    config: { defaultPlacement: 'pane', markerFile: '.conductor-agent', spawnDirPattern: './{codename}' },
    baseDir: '/tmp',
    agentConfigDir: '/tmp/agents',
    reloadAgents: () => undefined,
    healthReset: () => undefined,
    onStarted: async () => undefined,
  });
  const messaging = new Messaging({
    store,
    delivery,
    states,
    agents: () => agents,
    startAgent: (c, o) => lifecycle.start(c, o),
    channelSend: async () => false,
  });
  const humanInput = new HumanInputBroker({
    notifyOperator: async () => undefined,
    sentinelCodename: () => sentinelCodename,
    isActive: (a) => states.get(a)?.sessionActive === true,
    getAutonomy: (a) => states.getAutonomy(a),
    deliver: (a, t) => delivery.deliverOrQueue(a, t),
  });
  const sentinel = new StallSentinelRouter({
    config: { captureLines: 40, suppressWindowMs: 300_000, suppressSimilarity: 0.8, sentinelCodename },
    backend,
    runtimeFor: () => runtime,
    getPane: (a) => lifecycle.getPane(a),
    getAutonomy: (a) => states.getAutonomy(a),
    isActive: (a) => states.get(a)?.sessionActive === true,
    deliver: async () => 'delivered',
    notifyOperator: async () => undefined,
    logEvent: () => undefined,
  });

  for (const codename of agents.keys()) states.register(codename, false);

  tools = buildMcpTools({
    lifecycle,
    messaging,
    humanInput,
    sentinel,
    states,
    delivery,
    agents: () => agents,
    statusReport: (c) =>
      statusReport(
        {
          agents: () => agents,
          getState: (n) => states.get(n),
          sentinelCodename: () => sentinelCodename,
          pendingStallCount: () => 0,
        },
        c,
      ),
    tail: async (c, n) => `tail:${c}:${n}`,
    tailLimits: { defaultLines: 30, maxLines: 500 },
  });
});

afterEach(() => {
  store.close();
});

describe('whoami', () => {
  it('reports the calling agent’s own codename and status', async () => {
    states.setAutonomy('alpha', 'autonomous');
    states.setTag('alpha', 'refactor');
    const out = JSON.parse(await tool('whoami').handler({}, 'alpha')) as Record<string, unknown>;
    expect(out.codename).toBe('alpha');
    expect(out.registered).toBe(true);
    expect(out.isSentinel).toBe(false);
    expect(out.autonomy).toBe('autonomous');
    expect(out.tag).toBe('refactor');
  });

  it('reflects the mechanical caller, so two agents get different answers from the same tool', async () => {
    const alpha = JSON.parse(await tool('whoami').handler({}, 'alpha')) as { codename: string; isSentinel: boolean };
    const watch = JSON.parse(await tool('whoami').handler({}, 'watch')) as { codename: string; isSentinel: boolean };
    expect(alpha.codename).toBe('alpha');
    expect(alpha.isSentinel).toBe(false);
    expect(watch.codename).toBe('watch');
    expect(watch.isSentinel).toBe(true); // watch is the designated sentinel
  });

  it('marks an unregistered caller (e.g. the shared /mcp endpoint = "unknown")', async () => {
    const out = JSON.parse(await tool('whoami').handler({}, 'unknown')) as Record<string, unknown>;
    expect(out.codename).toBe('unknown');
    expect(out.registered).toBe(false);
    expect(out.sessionActive).toBe(false);
    expect(out.autonomy).toBeNull();
  });

  it('takes no arguments and is not sentinel-gated', () => {
    const def = tool('whoami');
    expect(def.sentinelOnly).toBeUndefined();
    expect(def.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});
