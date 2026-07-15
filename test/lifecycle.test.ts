import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentConfigs } from '../src/config/loader.js';
import type { AgentConfig } from '../src/config/schema.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { AgentStateManager } from '../src/core/state.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let baseDir: string;
let store: Store;
let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let states: AgentStateManager;
let lifecycle: Lifecycle;
let agents: Map<string, AgentConfig>;
let healthResets: string[];
let notified: string[];

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-lc-'));
  mkdirSync(join(baseDir, 'config', 'agents'), { recursive: true });
  const repo = join(baseDir, 'repos', 'alpha');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(baseDir, 'config', 'agents', 'alpha.yaml'), `codename: alpha\nrepo: ${repo}\n`);

  store = new Store(':memory:');
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  states = new AgentStateManager(store, 'facilitated');
  agents = loadAgentConfigs(baseDir);
  healthResets = [];
  notified = [];

  lifecycle = new Lifecycle({
    store,
    backend,
    states,
    runtimes: new Map([['claude-code', runtime]]),
    agents: () => agents,
    identityFor: (codename) => ({
      mcpUrl: `http://127.0.0.1:1/mcp/${codename}`,
      eventsUrl: `http://127.0.0.1:1/events/${codename}`,
      configDir: join(baseDir, 'data', 'agents', codename),
    }),
    config: { defaultPlacement: 'pane', markerFile: '.conductor-agent', spawnDirPattern: './spawned/{codename}' },
    baseDir,
    agentConfigDir: join(baseDir, 'config', 'agents'),
    reloadAgents: () => {
      agents = loadAgentConfigs(baseDir, { tolerant: true });
      for (const codename of agents.keys()) states.register(codename, false);
    },
    healthReset: (agent) => healthResets.push(agent),
    onStarted: async (agent) => {
      notified.push(agent);
    },
  });
  states.register('alpha', false);
});

afterEach(() => {
  store.close();
  rmSync(baseDir, { recursive: true, force: true });
});

describe('lifecycle edges', () => {
  it('runs prepare before launch and resets health on start', async () => {
    await lifecycle.start('alpha', { prompt: 'begin' });
    expect(runtime.prepared[0]?.agent.codename).toBe('alpha');
    expect(healthResets).toEqual(['alpha']);
    expect(notified).toEqual(['alpha']);
    const session = store.getActiveSessions()[0];
    expect(session?.agent).toBe('alpha');
    expect(session?.prompt_summary).toBe('begin');
  });

  it('recovers when state says active but the pane is dead', async () => {
    await lifecycle.start('alpha');
    const firstPane = lifecycle.getPane('alpha');
    expect(firstPane).toBeDefined();
    // Pane dies out from under us (user closed it, terminal crashed).
    await backend.kill(firstPane ?? { backend: 'fake', id: '' });

    const reply = await lifecycle.start('alpha');
    expect(reply).toBe('alpha started.');
    const secondPane = lifecycle.getPane('alpha');
    expect(secondPane?.id).not.toBe(firstPane?.id);
    expect(await backend.isAlive(secondPane ?? { backend: 'fake', id: '' })).toBe(true);
    // The interrupted session was closed out in the store.
    expect(store.getActiveSessions().length).toBe(1);
  });

  it('adopts a surviving pane after a conductor restart', async () => {
    const pane = await backend.createPane('alpha', 'pane');
    lifecycle.adopt('alpha', pane);
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(states.get('alpha')?.sessionActive).toBe(true);
    expect(states.get('alpha')?.activity).toBe('working');
  });

  it('handles an externally ended session exactly once', async () => {
    await lifecycle.start('alpha');
    lifecycle.handleSessionEnd('alpha');
    expect(states.get('alpha')?.sessionActive).toBe(false);
    expect(states.get('alpha')?.activity).toBe('stopped');
    expect(lifecycle.getPane('alpha')).toBeUndefined();
    expect(store.getActiveSessions()).toEqual([]);
    // Second call is a no-op, not a crash.
    lifecycle.handleSessionEnd('alpha');
  });

  it('restart cycles the pane', async () => {
    await lifecycle.start('alpha');
    const firstPane = lifecycle.getPane('alpha');
    await lifecycle.restart('alpha');
    const secondPane = lifecycle.getPane('alpha');
    expect(secondPane?.id).not.toBe(firstPane?.id);
    expect(backend.panes.get(firstPane?.id ?? '')?.alive).toBe(false);
    expect(await backend.isAlive(secondPane ?? { backend: 'fake', id: '' })).toBe(true);
  });

  it('stop is graceful about unknown agents and missing panes', async () => {
    expect(await lifecycle.stop('ghost')).toBe('Unknown agent: ghost');
    expect(await lifecycle.stop('alpha')).toBe('alpha stopped.'); // never started
  });

  it('resets health tracking on stop so stale timers cannot fire (H5)', async () => {
    await lifecycle.start('alpha');
    healthResets.length = 0;
    await lifecycle.stop('alpha');
    expect(healthResets).toContain('alpha');
  });

  it('serializes concurrent starts into a single pane (H6)', async () => {
    const [a, b] = await Promise.all([lifecycle.start('alpha'), lifecycle.start('alpha')]);
    // Both callers share one in-flight start and get the same result...
    expect(a).toBe('alpha started.');
    expect(b).toBe('alpha started.');
    // ...and exactly one pane was opened for the identity.
    const alphaPanes = [...backend.panes.values()].filter((p) => p.agent === 'alpha' && p.alive);
    expect(alphaPanes.length).toBe(1);
    expect(lifecycle.getPane('alpha')).toBeDefined();
  });

  it('kills the pane if launch setup throws, leaving no orphan (M16)', async () => {
    backend.launch = () => Promise.reject(new Error('shell init failed'));
    await expect(lifecycle.start('alpha')).rejects.toThrow('shell init failed');
    expect(lifecycle.getPane('alpha')).toBeUndefined();
    expect([...backend.panes.values()].every((p) => !p.alive)).toBe(true);
  });
});
