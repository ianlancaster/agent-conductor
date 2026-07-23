import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionConfigs } from '../src/config/loader.js';
import type { SessionConfig } from '../src/config/schema.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { SessionStateManager } from '../src/core/state.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let baseDir: string;
let store: Store;
let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let codexRuntime: FakeRuntime;
let states: SessionStateManager;
let lifecycle: Lifecycle;
let sessions: Map<string, SessionConfig>;
let supervisionResets: string[];
let defaultBypassPermissions: boolean;
let defaultEfforts: { 'claude-code': string | undefined; 'codex': string | undefined };

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-lc-'));
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  const repo = join(baseDir, 'repos', 'alpha');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'), `codename: alpha\nrepo: ${repo}\n`);

  store = new Store(':memory:');
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  codexRuntime = new FakeRuntime();
  states = new SessionStateManager(store, false);
  sessions = loadSessionConfigs(baseDir);
  supervisionResets = [];
  defaultBypassPermissions = true;
  defaultEfforts = { 'claude-code': undefined, 'codex': undefined };

  lifecycle = new Lifecycle({
    store,
    backend,
    states,
    runtimes: new Map([
      ['claude-code', runtime],
      ['codex', codexRuntime],
    ]),
    sessions: () => sessions,
    identityFor: (codename) => ({
      mcpUrl: `http://127.0.0.1:1/mcp/${codename}`,
      eventsUrl: `http://127.0.0.1:1/events/${codename}`,
      configDir: join(baseDir, 'data', 'sessions', codename),
    }),
    config: {
      defaultPlacement: 'pane',
      defaultRuntime: 'claude-code',
      defaultEfforts,
      get defaultBypassPermissions() {
        return defaultBypassPermissions;
      },
      markerFile: '.agent-marker',
      spawnDirPattern: './spawned/{codename}',
      spawnTemplates: {},
      templateCloneTimeoutMs: 5_000,
    },
    baseDir,
    sessionConfigDir: join(baseDir, 'config', 'sessions'),
    reloadSessions: () => {
      sessions = loadSessionConfigs(baseDir, { tolerant: true });
      for (const codename of sessions.keys()) states.register(codename, false);
    },
    supervisionReset: (session) => supervisionResets.push(session),
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
    expect(runtime.prepared[0]?.session.codename).toBe('alpha');
    expect(supervisionResets).toEqual(['alpha']);
    const session = store.getActiveRuns()[0];
    expect(session?.session).toBe('alpha');
    expect(session?.prompt_summary).toBe('begin');
  });

  it('resolves permission bypass from the fleet default and per-session override', async () => {
    await lifecycle.start('alpha');
    expect(runtime.launches.at(-1)?.opts.bypassPermissions).toBe(true);
    await lifecycle.stop('alpha');

    const alpha = sessions.get('alpha');
    if (alpha === undefined) throw new Error('alpha missing');
    sessions.set('alpha', { ...alpha, bypassPermissions: false });
    await lifecycle.start('alpha');
    expect(runtime.launches.at(-1)?.opts.bypassPermissions).toBe(false);
    await lifecycle.stop('alpha');

    sessions.set('alpha', { ...alpha, bypassPermissions: undefined });
    defaultBypassPermissions = false;
    await lifecycle.start('alpha');
    expect(runtime.launches.at(-1)?.opts.bypassPermissions).toBe(false);
  });

  it('resolves and persists per-run effort without validating new provider levels', async () => {
    const alpha = sessions.get('alpha');
    if (alpha === undefined) throw new Error('alpha missing');
    sessions.set('alpha', { ...alpha, effort: 'session-level' });

    await lifecycle.start('alpha', { effort: 'future-provider-level' });
    expect(runtime.launches.at(-1)?.opts.effort).toBe('future-provider-level');
    expect(states.get('alpha')?.effort).toBe('future-provider-level');
    expect(store.getSessionState('alpha')?.activeEffort).toBe('future-provider-level');

    await lifecycle.stop('alpha');
    expect(states.get('alpha')?.effort).toBeUndefined();
    expect(store.getSessionState('alpha')?.activeEffort).toBeNull();

    await lifecycle.start('alpha');
    expect(runtime.launches.at(-1)?.opts.effort).toBe('session-level');
  });

  it('overrides the configured runtime for one run and clears it when that run ends', async () => {
    const session = sessions.get('alpha');
    if (session !== undefined) {
      session.model = 'claude-only-model';
      session.effort = 'claude-only-effort';
    }
    defaultEfforts.codex = 'codex-default-effort';

    await lifecycle.start('alpha', { runtime: 'codex' });

    expect(runtime.prepared).toHaveLength(0);
    expect(codexRuntime.prepared[0]?.session).toMatchObject({ runtime: 'codex' });
    expect(codexRuntime.prepared[0]?.session.model).toBeUndefined();
    expect(codexRuntime.prepared[0]?.session.effort).toBeUndefined();
    expect(codexRuntime.launches[0]?.opts.effort).toBe('codex-default-effort');
    expect(lifecycle.runtimeNameFor('alpha')).toBe('codex');
    expect(states.get('alpha')?.runtime).toBe('codex');

    const restoredStates = new SessionStateManager(store, false);
    restoredStates.register('alpha', false);
    expect(restoredStates.get('alpha')?.runtime).toBe('codex');
    expect(restoredStates.get('alpha')?.effort).toBe('codex-default-effort');

    const pane = lifecycle.getPane('alpha');
    backend.endSession(pane?.id ?? '');
    await lifecycle.reconcile('alpha');
    expect(states.get('alpha')?.runtime).toBeUndefined();
    expect(lifecycle.runtimeNameFor('alpha')).toBe('claude-code');
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
    expect(store.getActiveRuns().length).toBe(1);
  });

  it('adopts a surviving pane after a conductor restart', async () => {
    const pane = await backend.createPane('alpha', 'pane');
    backend.panes.get(pane.id)!.sessionActive = true;
    lifecycle.adopt('alpha', pane);
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(states.get('alpha')?.running).toBe(true);
    expect(states.get('alpha')?.activity).toBe('working');
  });

  it('handles an externally ended session exactly once', async () => {
    await lifecycle.start('alpha');
    const pane = lifecycle.getPane('alpha');
    lifecycle.handleSessionEnd('alpha');
    expect(states.get('alpha')?.running).toBe(false);
    expect(states.get('alpha')?.activity).toBe('stopped');
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(store.getActiveRuns()).toEqual([]);
    // Second call is a no-op, not a crash.
    lifecycle.handleSessionEnd('alpha');
  });

  it('detects Ctrl-C as a stopped runtime and restarts it in the same pane', async () => {
    await lifecycle.start('alpha');
    const pane = lifecycle.getPane('alpha');
    expect(pane).toBeDefined();
    backend.endSession(pane!.id);

    await lifecycle.reconcile('alpha');
    expect(states.get('alpha')?.running).toBe(false);
    expect(states.get('alpha')?.activity).toBe('stopped');
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(store.getActiveRuns()).toEqual([]);

    expect(await lifecycle.start('alpha')).toBe('alpha started.');
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(backend.panes.size).toBe(1);
    expect(backend.panes.get(pane!.id)?.launched).toHaveLength(2);
    expect(states.get('alpha')?.running).toBe(true);
  });

  it('continues an ended runtime in its existing pane', async () => {
    await lifecycle.start('alpha');
    const pane = lifecycle.getPane('alpha')!;
    backend.endSession(pane.id);

    expect(await lifecycle.continue('alpha')).toBe('alpha continued.');
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(backend.panes.get(pane.id)?.launched.at(-1)).toContain('--continue');
    expect(runtime.prepared).toHaveLength(2);
  });

  it('continues with a per-run runtime override in the existing pane', async () => {
    await lifecycle.start('alpha');
    const pane = lifecycle.getPane('alpha')!;
    backend.endSession(pane.id);

    expect(await lifecycle.continue('alpha', { runtime: 'codex' })).toBe('alpha continued.');
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(codexRuntime.prepared.at(-1)?.session.runtime).toBe('codex');
    expect(states.get('alpha')?.runtime).toBe('codex');
  });

  it('discovers and reuses an idle marked pane before creating a new one', async () => {
    const pane = await backend.createPane('alpha', 'pane');
    backend.survivors.set('alpha', pane);

    expect(await lifecycle.start('alpha')).toBe('alpha started.');
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(backend.panes.size).toBe(1);
  });

  it('teardown closes an idle pane left by an ended runtime', async () => {
    await lifecycle.start('alpha');
    const pane = lifecycle.getPane('alpha')!;
    backend.endSession(pane.id);
    await lifecycle.reconcile('alpha');

    await lifecycle.teardown('alpha');
    expect(backend.panes.get(pane.id)?.alive).toBe(false);
    expect(lifecycle.getPane('alpha')).toBeUndefined();
  });

  it('restart cycles the pane', async () => {
    await lifecycle.start('alpha');
    const firstPane = lifecycle.getPane('alpha');
    await lifecycle.restart('alpha');
    const secondPane = lifecycle.getPane('alpha');
    expect(secondPane?.id).not.toBe(firstPane?.id);
    expect(backend.panes.get(firstPane?.id ?? '')?.alive).toBe(false);
    expect(await backend.isAlive(secondPane ?? { backend: 'fake', id: '' })).toBe(true);
    expect(runtime.prepared).toHaveLength(2);
  });

  it('stop is graceful about unknown sessions and missing panes', async () => {
    expect(await lifecycle.stop('ghost')).toBe('Unknown session: ghost');
    expect(await lifecycle.stop('alpha')).toBe('alpha stopped.'); // never started
  });

  it('resets health tracking on stop so stale timers cannot fire (H5)', async () => {
    await lifecycle.start('alpha');
    supervisionResets.length = 0;
    await lifecycle.stop('alpha');
    expect(supervisionResets).toContain('alpha');
  });

  it('serializes concurrent starts into a single pane (H6)', async () => {
    const [a, b] = await Promise.all([lifecycle.start('alpha'), lifecycle.start('alpha')]);
    // Both callers share one in-flight start and get the same result...
    expect(a).toBe('alpha started.');
    expect(b).toBe('alpha started.');
    // ...and exactly one pane was opened for the identity.
    const alphaPanes = [...backend.panes.values()].filter((p) => p.session === 'alpha' && p.alive);
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
