import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionConfigs } from '../src/config/loader.js';
import { ConfigWatcher } from '../src/config/watcher.js';
import type { SessionConfig } from '../src/config/schema.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { SessionStateManager } from '../src/core/state.js';
import type { PaneActivityEvidence } from '../src/core/types.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';

let baseDir: string;
let store: Store;
let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let codexRuntime: FakeRuntime;
let states: SessionStateManager;
let lifecycle: Lifecycle;
let sessions: Map<string, SessionConfig>;
let supervisionResets: string[];
let supervisionRunningStates: boolean[];
let defaultBypassPermissions: boolean;
let defaultEfforts: { 'claude-code': string | undefined; 'codex': string | undefined };
let lifecycleEvents: FakeEventPublisher;
let recoveredActivity: PaneActivityEvidence;
let refreshes: number;
let watcher: ConfigWatcher;

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
  supervisionRunningStates = [];
  defaultBypassPermissions = true;
  defaultEfforts = { 'claude-code': undefined, 'codex': undefined };
  lifecycleEvents = new FakeEventPublisher();
  recoveredActivity = 'idle';
  refreshes = 0;
  // Mirror production wiring: an on-demand poll reloads only when a session
  // file actually changed, so tests that mutate the in-memory roster keep it.
  watcher = new ConfigWatcher(join(baseDir, 'config', 'sessions'));
  watcher.onChange(() => {
    sessions = loadSessionConfigs(baseDir, { tolerant: true });
  });

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
    refreshSessions: () => {
      refreshes += 1;
      watcher.checkNow();
    },
    supervisionReset: (session) => {
      supervisionResets.push(session);
      supervisionRunningStates.push(states.get(session)?.running === true);
    },
    observeActivity: async () => recoveredActivity,
    events: lifecycleEvents,
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
    expect(supervisionRunningStates).toEqual([true]);
    const session = store.getActiveRuns()[0];
    expect(session?.session).toBe('alpha');
    expect(session?.prompt_summary).toBe('begin');
    expect(lifecycleEvents.events).toContainEqual({
      type: 'session.started',
      session: 'alpha',
      cause: 'start',
      runtime: 'claude-code',
    });
  });

  it('publishes stopped state before supervision reevaluates fleet membership', async () => {
    await lifecycle.start('alpha');
    await lifecycle.stop('alpha');

    expect(supervisionRunningStates).toEqual([true, false]);
    expect(lifecycleEvents.events).toContainEqual({
      type: 'session.stopped',
      session: 'alpha',
      cause: 'requested',
    });
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
    expect(lifecycleEvents.events).toContainEqual({
      type: 'session.started',
      session: 'alpha',
      cause: 'start',
      runtime: 'claude-code',
      launchEffort: 'future-provider-level',
    });

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
    expect(lifecycleEvents.events).toContainEqual({
      type: 'session.stopped',
      session: 'alpha',
      cause: 'pane-missing',
    });
  });

  it('adopts a surviving pane after a conductor restart', async () => {
    const pane = await backend.createPane('alpha', 'pane');
    backend.panes.get(pane.id)!.sessionActive = true;
    await lifecycle.adopt('alpha', pane);
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(states.get('alpha')?.running).toBe(true);
    expect(states.get('alpha')?.activity).toBe('idle');
  });

  it('records the model a launch actually pinned, taken from the runtime that pinned it', async () => {
    runtime.defaultModel = 'runtime-default';
    await lifecycle.start('alpha');

    expect(states.get('alpha')?.model).toBe('runtime-default');
    expect(lifecycleEvents.events).toContainEqual(
      expect.objectContaining({ type: 'session.started', cause: 'start', launchModel: 'runtime-default' }),
    );

    // A session pin outranks the runtime default, and the recorded value must be
    // the one the runtime itself resolved rather than a second copy in core.
    writeFileSync(
      join(baseDir, 'config', 'sessions', 'alpha.yaml'),
      `codename: alpha\nrepo: ${join(baseDir, 'repos', 'alpha')}\nmodel: pinned-model\n`,
    );
    watcher.checkNow();
    await lifecycle.restart('alpha');

    expect(states.get('alpha')?.model).toBe('pinned-model');
  });

  it('records the rendered hook digest only from runtime preparation and freezes it for the launch', async () => {
    runtime.preparation = { hooksRenderedDigest: 'a'.repeat(64) };
    await lifecycle.start('alpha');

    expect(states.get('alpha')?.hooksRenderedDigest).toBe('a'.repeat(64));
    expect(store.getSessionState('alpha')?.activeHooksRenderedDigest).toBe('a'.repeat(64));

    // A later declaration/config edit cannot rewrite the launch artifact. Only
    // another runtime preparation attached to an actual launch may replace it.
    runtime.preparation = { hooksRenderedDigest: 'b'.repeat(64) };
    expect(states.get('alpha')?.hooksRenderedDigest).toBe('a'.repeat(64));

    await lifecycle.restart('alpha');
    expect(states.get('alpha')?.hooksRenderedDigest).toBe('b'.repeat(64));
  });

  it('does not report a launch model for a process it did not launch', async () => {
    // The defect this replaces: `launchModel` was re-derived from the config at
    // emit time, so adopting a surviving pane reported whatever the config said
    // NOW as though it were that process's launch — manufacturing agreement
    // between a stale process and an edited declaration.
    runtime.defaultModel = 'launched-with-this';
    const pane = await backend.createPane('alpha', 'pane');
    backend.panes.get(pane.id)!.sessionActive = true;

    await lifecycle.adopt('alpha', pane);

    const adopted = lifecycleEvents.events.filter(
      (event) => event.type === 'session.started' && event.cause === 'adopt',
    );
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).not.toHaveProperty('launchModel');
    expect(states.get('alpha')?.model).toBeUndefined();
    expect(states.get('alpha')?.hooksRenderedDigest).toBeUndefined();
  });

  it('keeps a launch record across adoption instead of re-deriving it', async () => {
    runtime.defaultModel = 'launched-with-this';
    await lifecycle.start('alpha');
    const pane = lifecycle.getPane('alpha');

    // The declaration changes under the running process, as a hand edit would.
    writeFileSync(
      join(baseDir, 'config', 'sessions', 'alpha.yaml'),
      `codename: alpha\nrepo: ${join(baseDir, 'repos', 'alpha')}\nmodel: edited-after-launch\n`,
    );
    watcher.checkNow();
    // A fresh conductor re-adopting the same live pane must still report the
    // launch, not the edit.
    await lifecycle.adopt('alpha', pane!);

    expect(states.get('alpha')?.model).toBe('launched-with-this');
    const adopted = lifecycleEvents.events.filter(
      (event) => event.type === 'session.started' && event.cause === 'adopt',
    );
    expect(adopted.at(-1)).toMatchObject({ launchModel: 'launched-with-this' });
  });

  it('clears the launch record when the process stops', async () => {
    runtime.defaultModel = 'launched-with-this';
    runtime.preparation = { hooksRenderedDigest: 'c'.repeat(64) };
    await lifecycle.start('alpha');
    expect(states.get('alpha')?.launchedAt).toBeDefined();

    await lifecycle.stop('alpha');

    // A leftover model on a stopped session would later read as a live fact.
    expect(states.get('alpha')?.model).toBeUndefined();
    expect(states.get('alpha')?.launchedAt).toBeUndefined();
    expect(states.get('alpha')?.hooksRenderedDigest).toBeUndefined();
  });

  it('keeps a surviving pane working when no composer is visible', async () => {
    recoveredActivity = 'working';
    const pane = await backend.createPane('alpha', 'pane');
    backend.panes.get(pane.id)!.sessionActive = true;

    await lifecycle.adopt('alpha', pane);

    expect(states.get('alpha')?.activity).toBe('working');
  });

  it('preserves prior activity when recovery capture is inconclusive', async () => {
    states.setActivity('alpha', 'idle');
    recoveredActivity = 'unknown';
    const pane = await backend.createPane('alpha', 'pane');
    backend.panes.get(pane.id)!.sessionActive = true;

    await lifecycle.adopt('alpha', pane);

    expect(states.get('alpha')?.activity).toBe('idle');
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

  it('keeps a live session running when the terminal cannot be observed', async () => {
    // A terminal that cannot answer is not a terminal reporting a dead pane.
    // Reading the first as the second retires a working session for good:
    // reconcile only visits mapped panes, so once the mapping is dropped
    // nothing revisits the seat and it stays stopped until a human notices.
    await lifecycle.start('alpha');
    const pane = lifecycle.getPane('alpha');
    expect(pane).toBeDefined();

    backend.unobservable.add(pane!.id);
    await lifecycle.reconcile('alpha');

    expect(states.get('alpha')?.running).toBe(true);
    expect(states.get('alpha')?.activity).not.toBe('stopped');
    // The mapping survives, so the next tick can still reach the pane.
    expect(lifecycle.getPane('alpha')).toEqual(pane);
    expect(store.getActiveRuns()).toHaveLength(1);
    expect(lifecycleEvents.events).not.toContainEqual({
      type: 'session.stopped',
      session: 'alpha',
      cause: 'pane-missing',
    });

    // Recorded as an unknown rather than a liveness claim in either direction.
    expect(lifecycle.processObservation('alpha')?.active).toBeNull();

    // And when the terminal answers again, nothing needed repairing.
    backend.unobservable.delete(pane!.id);
    await lifecycle.reconcile('alpha');
    expect(states.get('alpha')?.running).toBe(true);
    expect(lifecycle.processObservation('alpha')?.active).toBe(true);
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
    expect(lifecycleEvents.events).toContainEqual({
      type: 'session.stopped',
      session: 'alpha',
      cause: 'runtime-exit',
    });

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
    expect(lifecycleEvents.events).toContainEqual({
      type: 'session.started',
      session: 'alpha',
      cause: 'continue',
      runtime: 'claude-code',
    });
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

  it('reports a running runtime discovered outside lifecycle control', async () => {
    const pane = await backend.createPane('alpha', 'pane');
    backend.panes.get(pane.id)!.sessionActive = true;
    backend.survivors.set('alpha', pane);

    expect(await lifecycle.start('alpha')).toBe('alpha is already running.');
    expect(lifecycleEvents.events).toContainEqual({
      type: 'session.started',
      session: 'alpha',
      cause: 'discovered',
      runtime: 'claude-code',
    });
    expect(states.get('alpha')?.activity).toBe('idle');
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

  it('emits path-free workspace facts for an empty spawned lane and its removal', async () => {
    await lifecycle.spawn('worker');
    expect(lifecycleEvents.events).toContainEqual({
      type: 'workspace.provisioned',
      session: 'worker',
      kind: 'empty',
    });

    await lifecycle.teardown('worker', true);
    expect(lifecycleEvents.events).toContainEqual({
      type: 'workspace.removed',
      session: 'worker',
      kind: 'directory',
    });
    expect(JSON.stringify(lifecycleEvents.events)).not.toContain(join(baseDir, 'spawned', 'worker'));
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

  it('launches the session file as it is on disk, not as it was at the last poll', async () => {
    // Config files hot-reload on a timer, but a launch reads the in-memory
    // roster. An operator who edits YAML and restarts within the poll interval
    // would otherwise relaunch the previous configuration and be told nothing.
    writeFileSync(
      join(baseDir, 'config', 'sessions', 'alpha.yaml'),
      `codename: alpha\nrepo: ${join(baseDir, 'repos', 'alpha')}\nmodel: edited-after-the-last-poll\n`,
    );

    await lifecycle.start('alpha');

    expect(refreshes).toBeGreaterThan(0);
    expect(runtime.launches.at(-1)?.session.model).toBe('edited-after-the-last-poll');
  });

  it('does not let a second supervisor stop the pane a recovery just opened', async () => {
    // The configuration Conductor's own docs recommend — auto stall routing plus
    // a scheduled backup sweep — makes two callers recovering one dead seat a
    // normal event. Unserialized, the second caller's stop lands inside the
    // first caller's launch: the recovery reports success while the seat it
    // just claimed is already dead.
    await lifecycle.start('alpha');
    const events: string[] = [];
    const launched = backend.launch.bind(backend);
    const killed = backend.kill.bind(backend);
    backend.launch = async (pane, command) => {
      events.push(`launch ${pane.id} begin`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result = await launched(pane, command);
      events.push(`launch ${pane.id} end`);
      return result;
    };
    backend.kill = async (pane) => {
      events.push(`kill ${pane.id}`);
      return killed(pane);
    };

    const recovering = lifecycle.restart('alpha', { initiator: 'agent-stubbs' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stopping = lifecycle.stop('alpha', { initiator: 'agent-ford' });

    await expect(recovering).resolves.toBe('alpha started.');
    await expect(stopping).resolves.toBe('alpha stopped.');

    // The recovery's replacement pane is launched to completion before the
    // second caller's stop touches it — never killed mid-launch.
    const replacement = events.find((event) => event.endsWith('begin') && !event.startsWith('launch pane-1'));
    const replacementPane = replacement?.split(' ')[1] ?? '';
    expect(events).toEqual([
      'kill pane-1',
      `launch ${replacementPane} begin`,
      `launch ${replacementPane} end`,
      `kill ${replacementPane}`,
    ]);
    expect(states.get('alpha')?.running).toBe(false);
    expect(lifecycle.operationInFlight('alpha')).toBeUndefined();
  });

  it('publishes an advisory marker naming the transition and who asked for it', async () => {
    await lifecycle.start('alpha');
    let observed: ReturnType<typeof lifecycle.operationInFlight>;
    backend.kill = async () => {
      observed = lifecycle.operationInFlight('alpha');
      await Promise.resolve();
    };

    await lifecycle.stop('alpha', { initiator: 'agent-stubbs' });

    expect(observed?.kind).toBe('stop');
    expect(observed?.initiator).toBe('agent-stubbs');
    expect(observed?.since).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    // The marker is advisory and must not outlive the transition it describes.
    expect(lifecycle.operationInFlight('alpha')).toBeUndefined();
  });

  it('does not let a failed transition wedge the seat for the next caller', async () => {
    backend.launch = () => Promise.reject(new Error('shell init failed'));
    await expect(lifecycle.start('alpha')).rejects.toThrow('shell init failed');
    expect(lifecycle.operationInFlight('alpha')).toBeUndefined();

    backend.launch = async () => undefined;
    await expect(lifecycle.start('alpha')).resolves.toBe('alpha started.');
  });

  it('skips reconciliation while a transition owns the session', async () => {
    // A status or cron liveness check that lands mid-stop reads a torn frame and
    // then writes that stale conclusion over the transition's own result.
    await lifecycle.start('alpha');
    let reconciledDuringStop = false;
    backend.kill = async () => {
      await lifecycle.reconcile('alpha');
      reconciledDuringStop = states.get('alpha')?.running !== true;
    };

    await lifecycle.stop('alpha');

    expect(reconciledDuringStop).toBe(false);
    expect(states.get('alpha')?.running).toBe(false);
  });

  it('kills the pane if launch setup throws, leaving no orphan (M16)', async () => {
    backend.launch = () => Promise.reject(new Error('shell init failed'));
    await expect(lifecycle.start('alpha')).rejects.toThrow('shell init failed');
    expect(lifecycle.getPane('alpha')).toBeUndefined();
    expect([...backend.panes.values()].every((p) => !p.alive)).toBe(true);
    expect(lifecycleEvents.events).toContainEqual({
      type: 'session.stopped',
      session: 'alpha',
      cause: 'launch-failed',
    });
  });
});
