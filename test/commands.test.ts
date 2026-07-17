import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionConfigs } from '../src/config/loader.js';
import type { SessionConfig } from '../src/config/schema.js';
import { CommandRouter, tokenize } from '../src/core/commands.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Messaging } from '../src/core/messaging.js';
import { SessionStateManager } from '../src/core/state.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let baseDir: string;
let store: Store;
let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let states: SessionStateManager;
let lifecycle: Lifecycle;
let router: CommandRouter;
let operatorMessages: string[];
let sessions: Map<string, SessionConfig>;

function writeSessionConfig(codename: string): void {
  const repo = join(baseDir, 'repos', codename);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(baseDir, 'config', 'sessions', `${codename}.yaml`), `codename: ${codename}\nrepo: ${repo}\n`);
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-cmd-'));
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  writeSessionConfig('alpha');
  writeSessionConfig('beta');

  store = new Store(':memory:');
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  states = new SessionStateManager(store, 'facilitated');
  operatorMessages = [];
  sessions = loadSessionConfigs(baseDir);

  const delivery = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => lifecycle.getPane(session),
    isReady: (session) => states.isReady(session),
    config: { queueDrainMs: 2000, queueMaxAgeMs: 60_000 },
  });

  lifecycle = new Lifecycle({
    store,
    backend,
    states,
    runtimes: new Map([['claude-code', runtime]]),
    sessions: () => sessions,
    identityFor: (codename) => ({
      mcpUrl: `http://127.0.0.1:1/mcp/${codename}`,
      eventsUrl: `http://127.0.0.1:1/events/${codename}`,
      configDir: join(baseDir, 'data', 'sessions', codename),
    }),
    config: { defaultPlacement: 'pane', markerFile: '.conductor-agent', spawnDirPattern: './spawned/{codename}' },
    baseDir,
    sessionConfigDir: join(baseDir, 'config', 'sessions'),
    reloadSessions: () => {
      sessions = loadSessionConfigs(baseDir, { tolerant: true });
      for (const codename of sessions.keys()) states.register(codename, false);
    },
    healthReset: () => undefined,
    onStarted: async () => undefined,
  });

  const messaging = new Messaging({
    store,
    delivery,
    states,
    sessions: () => sessions,
    startSession: (codename, opts) => lifecycle.start(codename, opts),
    channelSend: async (text) => {
      operatorMessages.push(text);
      return true;
    },
  });

  for (const codename of sessions.keys()) states.register(codename, false);

  router = new CommandRouter({
    lifecycle,
    messaging,
    states,
    delivery,
    sessions: () => sessions,
    statusReport: (codename) => (codename !== undefined ? `status:${codename}` : 'status:all'),
    tail: async (codename, lines) => `tail:${codename}:${lines}`,
    tailLimits: { defaultLines: 30, maxLines: 500 },
    autoPause: undefined,
  });
});

afterEach(() => {
  store.close();
  rmSync(baseDir, { recursive: true, force: true });
});

describe('tokenize', () => {
  it('splits on whitespace and honors double quotes', () => {
    expect(tokenize('/spawn newbie --prompt "do the thing" --tab')).toEqual([
      '/spawn',
      'newbie',
      '--prompt',
      'do the thing',
      '--tab',
    ]);
  });
});

describe('session commands', () => {
  it('starts, reports already-running, and stops a session', async () => {
    expect(await router.route('/start alpha')).toBe('alpha started.');
    expect(backend.paneFor('alpha')?.launched[0]).toContain('fake-launch alpha');
    expect(states.get('alpha')?.running).toBe(true);

    expect(await router.route('/start alpha')).toBe('alpha is already running.');
    expect(await router.route('/stop alpha')).toBe('alpha stopped.');
    expect(states.get('alpha')?.running).toBe(false);
  });

  it('starts all sessions with placement flags', async () => {
    const reply = await router.route('/start all --tab');
    expect(reply).toContain('alpha started.');
    expect(reply).toContain('beta started.');
    expect(backend.paneFor('alpha')?.placement).toBe('tab');
  });

  it('continues with the continue flag in the launch command', async () => {
    await router.route('/continue alpha');
    expect(backend.paneFor('alpha')?.launched[0]).toContain('--continue');
  });

  it('rejects unknown sessions', async () => {
    expect(await router.route('/start ghost')).toBe('Unknown session: ghost');
  });
});

describe('conversation commands', () => {
  it('tell starts a stopped session with the message as prompt', async () => {
    const reply = await router.route('/tell beta check the build');
    expect(reply).toContain('started with your message');
    expect(backend.paneFor('beta')?.launched[0]).toContain('[Message from operator] check the build');
  });

  it('talk + free text routes to the talk target', async () => {
    await router.route('/start alpha');
    expect(await router.route('/talk alpha')).toContain('Talking to alpha');
    await router.route('please review the PR');
    expect(backend.paneFor('alpha')?.received).toContain('[Message from operator] please review the PR');
  });

  it('free text without a talk target explains itself', async () => {
    expect(await router.route('hello?')).toContain('No active conversation');
  });

  it('session-shortcut command sets the target and sends', async () => {
    await router.route('/start alpha');
    await router.route('/alpha ship it');
    expect(backend.paneFor('alpha')?.received).toContain('[Message from operator] ship it');
  });

  it('broadcast reaches active sessions only', async () => {
    await router.route('/start alpha');
    const reply = await router.route('/broadcast stand-up in 5');
    expect(reply).toBe('Broadcast delivered to 1 session(s).');
    expect(backend.paneFor('alpha')?.received).toContain('[Broadcast from operator] stand-up in 5');
  });
});

describe('mode commands', () => {
  it('sets autonomy for one or all sessions', async () => {
    expect(await router.route('/auto alpha')).toBe('alpha set to autonomous.');
    expect(states.getAutonomy('alpha')).toBe('autonomous');
    await router.route('/facilitated all');
    expect(states.getAutonomy('alpha')).toBe('facilitated');
  });

  it('pauses and resumes with mode memory', async () => {
    await router.route('/auto alpha');
    expect(await router.route('/pause alpha')).toBe('alpha: paused');
    expect(states.getAutonomy('alpha')).toBe('facilitated');
    expect(await router.route('/pause alpha')).toBe('alpha: already paused or facilitated');
    expect(await router.route('/resume alpha')).toBe('alpha: resumed');
    expect(states.getAutonomy('alpha')).toBe('autonomous');
  });

  it('sets and clears tags', async () => {
    await router.route('/tag alpha refactor sprint');
    expect(states.getTag('alpha')).toBe('refactor sprint');
    await router.route('/tag alpha');
    expect(states.getTag('alpha')).toBeUndefined();
  });

  it('reports autopause unsupported without a capable backend', async () => {
    expect(await router.route('/autopause on')).toContain('not supported');
  });
});

describe('tail and status', () => {
  it('clamps tail lines to limits', async () => {
    expect(await router.route('/tail alpha 9999')).toBe('tail:alpha:500');
    expect(await router.route('/tail alpha')).toBe('tail:alpha:30');
  });

  it('routes status with and without a session', async () => {
    expect(await router.route('/status')).toBe('status:all');
    expect(await router.route('/status alpha')).toBe('status:alpha');
  });
});

describe('spawn and teardown', () => {
  it('spawns a new session end to end and tears it down with directory deletion', async () => {
    const reply = await router.route('/spawn newbie --prompt "hello world"');
    expect(reply).toContain('Spawned newbie');
    expect(sessions.has('newbie')).toBe(true);
    expect(backend.paneFor('newbie')?.launched[0]).toContain('hello world');
    const spawnedDir = join(baseDir, 'spawned', 'newbie');
    expect(existsSync(spawnedDir)).toBe(true);

    const teardown = await router.route('/teardown newbie --delete');
    expect(teardown).toContain('newbie deregistered');
    expect(teardown).toContain('Directory deleted');
    expect(existsSync(spawnedDir)).toBe(false);
    expect(sessions.has('newbie')).toBe(false);
  });

  it('rejects a traversal codename before writing any files (H7)', async () => {
    const reply = await router.route('/spawn ../../../etc/evil');
    expect(reply).toContain('Invalid codename');
    expect(existsSync(join(baseDir, '..', '..', '..', 'etc', 'evil'))).toBe(false);
    expect(sessions.has('../../../etc/evil')).toBe(false);
  });

  it('serializes model values as YAML data, not injectable config (H7)', async () => {
    // A real newline inside the quoted model value: string interpolation would
    // have injected a `runtime:` key; js-yaml keeps it a single scalar.
    await router.route('/spawn injected --model "sonnet\nruntime: evil"');
    const spawned = sessions.get('injected');
    expect(spawned?.runtime).toBe('claude-code');
    expect(spawned?.model).toContain('sonnet');
  });

  it('refuses to delete directories containing a git repo', async () => {
    await router.route('/spawn gitty');
    mkdirSync(join(baseDir, 'spawned', 'gitty', '.git'), { recursive: true });
    const reply = await router.route('/teardown gitty --delete');
    expect(reply).toContain('Directory kept');
    expect(existsSync(join(baseDir, 'spawned', 'gitty'))).toBe(true);
  });
});
