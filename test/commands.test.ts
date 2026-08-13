import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionConfigs } from '../src/config/loader.js';
import type { SessionConfig } from '../src/config/schema.js';
import { CommandRouter, tokenize } from '../src/core/commands.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Messaging } from '../src/core/messaging.js';
import { ConductorOperations } from '../src/core/operations.js';
import { OperatorRequests } from '../src/core/operator-requests.js';
import { Rooms } from '../src/core/rooms.js';
import type { ChannelMessage } from '../src/channels/types.js';
import { StallSentinelRouter } from '../src/core/sentinel.js';
import { SessionStateManager } from '../src/core/state.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';

let baseDir: string;
let store: Store;
let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let codexRuntime: FakeRuntime;
let delivery: DeliveryQueue;
let states: SessionStateManager;
let lifecycle: Lifecycle;
let router: CommandRouter;
let operatorMessages: ChannelMessage[];
let sessions: Map<string, SessionConfig>;
let events: FakeEventPublisher;
let runbookCalls: { action: string; input: unknown }[];
let shepherdPauseChanges: { session: string; paused: boolean }[];

function writeSessionConfig(codename: string): void {
  const repo = join(baseDir, 'repos', codename);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(baseDir, 'config', 'sessions', `${codename}.yaml`), `codename: ${codename}\nrepo: ${repo}\n`);
}

const gitEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) {
  delete gitEnv[key];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
    env: gitEnv,
  });
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-cmd-'));
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  writeSessionConfig('alpha');
  writeSessionConfig('beta');

  store = new Store(':memory:');
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  codexRuntime = new FakeRuntime();
  states = new SessionStateManager(store, false);
  operatorMessages = [];
  sessions = loadSessionConfigs(baseDir);
  events = new FakeEventPublisher();
  runbookCalls = [];
  shepherdPauseChanges = [];

  delivery = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => lifecycle.getPane(session),
    config: { queueDrainMs: 2000 },
  });

  lifecycle = new Lifecycle({
    store,
    backend,
    states,
    runtimes: new Map([
      ['claude-code', runtime],
      ['codex', codexRuntime],
      ['spartan', codexRuntime],
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
      defaultEfforts: { 'claude-code': undefined, 'codex': undefined, 'spartan': undefined },
      defaultBypassPermissions: true,
      markerFile: '.agent-marker',
      spawnDirPattern: './spawned/{codename}',
      spawnTemplates: { local: { source: './template-source' } },
      templateCloneTimeoutMs: 5_000,
    },
    baseDir,
    sessionConfigDir: join(baseDir, 'config', 'sessions'),
    reloadSessions: () => {
      sessions = loadSessionConfigs(baseDir, { tolerant: true });
      for (const codename of sessions.keys()) states.register(codename, false);
    },
    supervisionReset: () => undefined,
    events,
  });

  const messaging = new Messaging({
    store,
    delivery,
    states,
    sessions: () => sessions,
    startSession: (codename, opts) => lifecycle.start(codename, opts),
    events,
  });
  const operatorRequests = new OperatorRequests({
    store,
    messaging,
    channelSend: async (message) => {
      operatorMessages.push(message);
      return true;
    },
  });

  for (const codename of sessions.keys()) states.register(codename, false);

  const sentinel = new StallSentinelRouter({
    config: {
      captureLines: 40,
      suppressWindowMs: 300_000,
      suppressSimilarity: 0.8,
      sentinelCodename: undefined,
      fleetStallThresholdSeconds: 15,
    },
    initialSessions: sessions.keys(),
    backend,
    runtimeFor: () => runtime,
    getPane: (codename) => lifecycle.getPane(codename),
    isAuto: (codename) => states.isAuto(codename),
    isPaused: (codename) => states.isPaused(codename),
    activityFor: (codename) => states.get(codename)?.activity,
    isActive: (codename) => states.get(codename)?.running === true,
    deliver: (codename, text) => delivery.deliverOrQueue(codename, text),
    notifyOperator: async () => undefined,
    logEvent: () => undefined,
  });
  const operations = new ConductorOperations({
    lifecycle,
    messaging,
    rooms: new Rooms({
      store,
      delivery,
      states,
      sessions: () => sessions,
      channelSend: async (message) => {
        operatorMessages.push(message);
        return true;
      },
      events,
    }),
    operatorRequests,
    sentinel,
    states,
    sessions: () => sessions,
    allowsSelfAuto: () => false,
    modelHints: { 'claude-code': [], 'codex': [], 'spartan': [] },
    effortHints: { 'claude-code': [], 'codex': [], 'spartan': [] },
    statusReport: (codename) => (codename !== undefined ? `status:${codename}` : 'status:all'),
    tail: async (codename, lines) => `tail:${codename}:${lines}`,
    typeInPane: async (codename, text) => {
      const pane = lifecycle.getPane(codename);
      if (pane === undefined) return `${codename} has no active pane.`;
      await backend.run(pane, text);
      return `Typed into ${codename}'s pane.`;
    },
    tailLimits: { defaultLines: 30, maxLines: 500 },
    retitle: async () => undefined,
    summon: async (codename) => `summoned:${codename}`,
    banish: async (codename) => `banished:${codename}`,
    setSentinel: (codename) => {
      if (codename !== undefined && !states.has(codename)) throw new Error(`Unknown session: ${codename}`);
      sentinel.setSentinel(codename);
    },
    setShepherdPausedForSession: (session, paused) => {
      shepherdPauseChanges.push({ session, paused });
      return Promise.resolve();
    },
    getDocumentation: async (topic) => `docs:${topic ?? 'index'}`,
    runbookAdoptions: {
      adopt: (input) => {
        runbookCalls.push({ action: 'adopt', input });
        return 'adoption-created';
      },
      supersede: (input) => {
        runbookCalls.push({ action: 'supersede', input });
        return 'adoption-superseded';
      },
      end: (adoptionId) => {
        runbookCalls.push({ action: 'end', input: adoptionId });
        return 'adoption-ended';
      },
    },
  });
  router = new CommandRouter(operations);
});

afterEach(() => {
  delivery.stop();
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

describe('runbook provenance command', () => {
  it('parses adopt, supersede, and end through the canonical operations', async () => {
    await expect(
      router.route(
        '/runbook adopt team/workflow --version 1.2.0 --topic lean --session alpha=manager --session "beta=senior reviewer"',
      ),
    ).resolves.toBe('adoption-created');
    await expect(
      router.route('/runbook supersede adoption-1 --with team/lean --version 2.0.0 --topic overview'),
    ).resolves.toBe('adoption-superseded');
    await expect(router.route('/runbook end adoption-2')).resolves.toBe('adoption-ended');

    expect(runbookCalls).toEqual([
      {
        action: 'adopt',
        input: {
          runbookId: 'team/workflow',
          version: '1.2.0',
          topic: 'lean',
          sessions: ['alpha=manager', 'beta=senior reviewer'],
        },
      },
      {
        action: 'supersede',
        input: { adoptionId: 'adoption-1', runbookId: 'team/lean', version: '2.0.0', topic: 'overview' },
      },
      { action: 'end', input: 'adoption-2' },
    ]);
  });

  it('documents the full command and rejects incomplete provenance', async () => {
    const help = await router.route('/help');
    expect(help).toContain('/runbook <adopt|supersede|end> ...');
    expect(help).toContain('adopt <id> --version <v> --topic <topic>');
    await expect(router.route('/runbook adopt team/workflow --version 1.0.0')).resolves.toContain('Usage:');
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

  it('types raw text immediately without entering the protected delivery queue', async () => {
    await router.route('/start alpha');
    runtime.inputState = 'draft';

    expect(await router.route('/type alpha /model gpt-5.6')).toBe("Typed into alpha's pane.");
    expect(backend.paneFor('alpha')?.received).toEqual(['/model gpt-5.6']);
  });

  it('starts a session headless with -H and plumbs it to the backend', async () => {
    expect(await router.route('/start alpha -H')).toBe('alpha started.');
    expect(backend.paneFor('alpha')?.headless).toBe(true);
    // Default start is NOT headless.
    await router.route('/stop alpha');
    expect(await router.route('/start alpha')).toBe('alpha started.');
    expect(backend.paneFor('alpha')?.headless).toBe(false);
  });

  it('routes /summon and /banish with an unknown-session guard', async () => {
    expect(await router.route('/summon alpha')).toBe('summoned:alpha');
    expect(await router.route('/banish alpha')).toBe('banished:alpha');
    expect(await router.route('/summon nope')).toBe('Unknown session: nope');
    expect(await router.route('/summon')).toBe('Usage: /summon <session>');
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
    expect(runtime.launches.at(-1)?.opts.resumeSessionId).toBeUndefined();
  });

  it('continues a specific runtime conversation by session ID', async () => {
    expect(await router.route('/continue alpha --session-id "provider session"')).toBe('alpha continued.');
    expect(runtime.launches.at(-1)?.opts.resumeSessionId).toBe('provider session');
    expect(backend.paneFor('alpha')?.launched[0]).toContain('--session-id "provider session"');
  });

  it('accepts -s as the session ID alias', async () => {
    expect(await router.route('/continue alpha -s provider-session')).toBe('alpha continued.');
    expect(runtime.launches.at(-1)?.opts.resumeSessionId).toBe('provider-session');
  });

  it('rejects a session ID without one specific Conductor session', async () => {
    expect(await router.route('/continue all --session-id provider-session')).toBe(
      "'sessionId' cannot be used when codename is 'all'",
    );
    expect(runtime.launches).toHaveLength(0);
    expect(await router.route('/continue alpha --session-id')).toContain('Usage: /continue <session|all>');
  });

  it('starts and continues with a runtime override', async () => {
    expect(await router.route('/start alpha --runtime codex')).toBe('alpha started.');
    expect(codexRuntime.prepared.at(-1)?.session.runtime).toBe('codex');
    expect(states.get('alpha')?.runtime).toBe('codex');

    await router.route('/stop alpha');
    expect(await router.route('/continue alpha -r codex')).toBe('alpha continued.');
    expect(codexRuntime.prepared.at(-1)?.session.runtime).toBe('codex');
    expect(backend.paneFor('alpha')?.launched.at(-1)).toContain('--continue');
  });

  it('passes arbitrary effort levels through start and continue', async () => {
    expect(await router.route('/start alpha --effort future-provider-level')).toBe('alpha started.');
    expect(runtime.launches.at(-1)?.opts.effort).toBe('future-provider-level');
    expect(states.get('alpha')?.effort).toBe('future-provider-level');

    await router.route('/stop alpha');
    expect(await router.route('/continue alpha -e max')).toBe('alpha continued.');
    expect(runtime.launches.at(-1)?.opts.effort).toBe('max');
    expect(states.get('alpha')?.effort).toBe('max');
  });

  it('normalizes cc to claude-code for start and continue', async () => {
    expect(await router.route('/start alpha -r cc')).toBe('alpha started.');
    expect(runtime.prepared.at(-1)?.session.runtime).toBe('claude-code');
    expect(states.get('alpha')?.runtime).toBe('claude-code');

    await router.route('/stop alpha');
    expect(await router.route('/continue alpha --runtime cc')).toBe('alpha continued.');
    expect(runtime.prepared.at(-1)?.session.runtime).toBe('claude-code');
    expect(states.get('alpha')?.runtime).toBe('claude-code');
  });

  it('rejects an invalid runtime override through canonical validation', async () => {
    expect(await router.route('/start alpha --runtime other')).toContain(
      "'runtime' must be one of: claude-code, cc, codex",
    );
    expect(states.get('alpha')?.running).toBe(false);
  });

  it('rejects unknown sessions', async () => {
    expect(await router.route('/start ghost')).toBe('Unknown session: ghost');
  });
});

describe('conversation commands', () => {
  it('routes /respond through the canonical operator request operation', async () => {
    store.insertOperatorRequest('alpha', 'Deploy?', ['Staging', 'Production']);
    expect(await router.route('/respond 1 2')).toContain('Response recorded: Production');
    expect(backend.paneFor('alpha')?.launched[0]).toContain('[Message from operator] Response to request #1');
    expect(backend.paneFor('alpha')?.launched[0]).toContain('Production');
    expect(await router.route('/respond 1 1')).toBe('Operator request #1 was already answered: Production');
    expect(await router.route('/respond nope 1')).toBe('Usage: /respond <request-id> <option-number>');
  });

  it('tell starts a stopped session with the message as prompt', async () => {
    const reply = await router.route('/tell beta check the build');
    expect(reply).toBe('Delivered message #1 for beta.');
    expect(backend.paneFor('beta')?.launched[0]).toContain('[Message from operator] check the build');
  });

  it('returns queued receipts and exposes their delivery status', async () => {
    await router.route('/start alpha');
    runtime.inputState = 'draft';

    expect(await router.route('/tell alpha wait for the draft')).toBe('Queued message #1 for alpha.');
    expect(JSON.parse(await router.route('/message-status 1'))).toMatchObject({
      id: 1,
      status: 'pending',
      inMemoryPendingForRecipient: 1,
    });

    runtime.inputState = 'clear';
    await delivery.drainNow();
    expect(JSON.parse(await router.route('/message-status 1'))).toMatchObject({
      id: 1,
      status: 'delivered',
      inMemoryPendingForRecipient: 0,
    });
  });

  it('talk + free text routes to the talk target', async () => {
    await router.route('/start alpha');
    expect(await router.route('/talk alpha')).toContain('Talking to alpha');
    await router.route('please review the PR');
    expect(backend.paneFor('alpha')?.received).toContain('[Message from operator] please review the PR');
  });

  it('isolates talk targets by operator conversation', async () => {
    await router.route('/start alpha');
    await router.route('/start beta');
    await router.route('/talk alpha', 'console-a');
    await router.route('/talk beta', 'telegram-chat');
    await router.route('from console', 'console-a');
    await router.route('from telegram', 'telegram-chat');
    expect(backend.paneFor('alpha')?.received).toContain('[Message from operator] from console');
    expect(backend.paneFor('beta')?.received).toContain('[Message from operator] from telegram');
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

describe('room commands', () => {
  it('convenes a room, speaks into it, and tears it down', async () => {
    await router.route('/start alpha');
    await router.route('/start beta');

    expect(await router.route('/room create standup alpha beta')).toBe(
      'Room standup created with members: alpha, beta.',
    );
    expect(await router.route('/room say standup what changed overnight?')).toBe(
      'Room standup: delivered to 2 member(s).',
    );
    expect(backend.paneFor('alpha')?.received).toContain('[Room: standup from operator] what changed overnight?');
    expect(await router.route('/room close standup')).toBe('Room standup closed; notified 2 member(s).');
  });

  it('puts the operator in a room so room traffic reaches the channels', async () => {
    await router.route('/start alpha');
    await router.route('/room create standup alpha');

    expect(await router.route('/room join standup')).toBe('The operator joined room standup.');
    expect(await router.route('/room leave standup')).toBe('The operator left room standup.');
  });

  it('adds and removes a named session', async () => {
    await router.route('/room create standup');

    expect(await router.route('/room join standup alpha')).toBe('alpha joined room standup.');
    expect(JSON.parse(await router.route('/room list standup'))).toEqual({
      rooms: [{ room: 'standup', members: [{ member: 'alpha', kind: 'session', running: false }] }],
    });
    expect(await router.route('/room leave standup alpha')).toBe('alpha left room standup.');
  });

  it('reports usage for every malformed room subcommand', async () => {
    expect(await router.route('/room')).toBe('Usage: /room <list|create|join|leave|close|say> ...');
    expect(await router.route('/room sing standup hello')).toBe('Usage: /room <list|create|join|leave|close|say> ...');
    expect(await router.route('/room say standup')).toBe('Usage: /room say <name> <message>');
    expect(await router.route('/room close')).toBe('Usage: /room <list|create|join|leave|close|say> ...');
    expect(await router.route('/room close standup extra')).toBe('Usage: /room close <name>');
    expect(await router.route('/room join standup alpha extra')).toBe('Usage: /room join <name> [session]');
  });
});

describe('mode commands', () => {
  it('toggles auto for one or all sessions', async () => {
    expect(await router.route('/auto alpha')).toBe('alpha: auto on');
    expect(states.isAuto('alpha')).toBe(true);
    expect(await router.route('/auto alpha')).toBe('alpha: auto off');
    expect(states.isAuto('alpha')).toBe(false);
    await router.route('/auto all');
    expect(states.isAuto('alpha')).toBe(true);
    expect(states.isAuto('beta')).toBe(true);
  });

  it('pauses and resumes without changing the auto setting', async () => {
    await router.route('/auto alpha');
    expect(await router.route('/pause alpha')).toBe('alpha: paused');
    expect(states.isAuto('alpha')).toBe(true);
    expect(states.isPaused('alpha')).toBe(true);
    expect(await router.route('/pause alpha')).toBe('alpha: already paused');
    expect(await router.route('/resume alpha')).toBe('alpha: resumed');
    expect(states.isAuto('alpha')).toBe(true);
    expect(states.isPaused('alpha')).toBe(false);
  });

  it('pauses schedules when auto is off', async () => {
    expect(states.isAuto('alpha')).toBe(false);
    expect(await router.route('/pause alpha')).toBe('alpha: paused');
    expect(states.isPaused('alpha')).toBe(true);
    expect(await router.route('/resume alpha')).toBe('alpha: resumed');
    expect(states.isAuto('alpha')).toBe(false);
  });

  it('applies pause and resume to companion lifecycle hooks for one session or all', async () => {
    await router.route('/pause alpha');
    await router.route('/resume alpha');
    expect(shepherdPauseChanges).toEqual([
      { session: 'alpha', paused: true },
      { session: 'alpha', paused: false },
    ]);

    shepherdPauseChanges = [];
    await router.route('/pause all');
    await router.route('/resume all');
    expect(shepherdPauseChanges).toEqual([
      { session: 'alpha', paused: true },
      { session: 'beta', paused: true },
      { session: 'alpha', paused: false },
      { session: 'beta', paused: false },
    ]);
  });

  it('sets and clears tags', async () => {
    await router.route('/tag alpha refactor sprint');
    expect(states.getTag('alpha')).toBe('refactor sprint');
    await router.route('/tag alpha');
    expect(states.getTag('alpha')).toBeUndefined();
  });

  it('returns a recoverable error for an over-limit tag', async () => {
    await router.route('/tag alpha concise');
    await expect(router.route(`/tag alpha ${'x'.repeat(51)}`)).resolves.toBe("'tag' must be at most 50 characters");
    expect(states.getTag('alpha')).toBe('concise');
  });

  it('does not expose the removed focus auto-pause command', async () => {
    expect(await router.route('/autopause on')).toContain('Unknown command');
  });

  it('does not expose the removed mode-setting commands', async () => {
    expect(await router.route('/autonomy alpha autonomous')).toContain('Unknown command');
    expect(await router.route('/facilitated alpha')).toContain('Unknown command');
  });

  it('does not expose a duplicate set_sentinel alias', async () => {
    expect(await router.route('/set_sentinel alpha')).toBe('Unknown command: /set_sentinel. Try /help.');
  });

  it('does not expose an undocumented duplicate talk alias', async () => {
    expect(await router.route('/speak alpha')).toBe('Unknown command: /speak. Try /help.');
  });

  it('does not expose status-derived exists or get-tag commands', async () => {
    expect(await router.route('/exists alpha')).toBe('Unknown command: /exists. Try /help.');
    expect(await router.route('/get-tag alpha')).toBe('Unknown command: /get-tag. Try /help.');
  });

  it('toggles fleet stall detection', async () => {
    expect(await router.route('/fleet-watch')).toBe('Fleet watch on.');
    expect(await router.route('/fleet-watch')).toBe('Fleet watch off.');
  });

  it('rejects arguments to the fleet-watch toggle', async () => {
    expect(await router.route('/fleet-watch list')).toContain('Usage: /fleet-watch');
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

describe('help', () => {
  it('renders plain headers and indents commands without Markdown noise', async () => {
    const help = await router.route('/help');
    expect(help).toContain('Sessions:\n  /status [session] —');
    expect(help).toContain('/start <session|all> [-r|--runtime cc|claude-code|codex|spartan]');
    expect(help).toContain('/continue <session|all> [-s|--session-id id] [-r|--runtime cc|claude-code|codex|spartan]');
    expect(help.match(/-e\|--effort level/gu)).toHaveLength(2);
    expect(help).toContain('Conversation:\n  /tell <session> <message> —');
    expect(help).toContain('/room <list|create|join|leave|close|say> ...');
    expect(help).toContain('    join <name> [session] · leave <name> [session] — omit session to act as the operator');
    expect(help).toContain('  -P/--pane · -T/--tab · -W/--window\n  -H/--headless — detached tmux pane');
    expect(help).toContain('    -r/--runtime cc|claude-code|codex|spartan');
    expect(help).toContain('-e/--effort <level>');
    expect(help).toContain('-s/--session-id <id>');
    expect(help).toContain('-t/--template <name>');
    expect(help).toContain('-a/--add-dir <dir> (repeatable)');
    expect(help).toContain('--system-prompt <file>');
    expect(help).toContain('/fleet-watch');
    expect(help).not.toContain('*Sessions*');
    expect(help).not.toContain('`/status');
  });
});

describe('spawn and teardown', () => {
  it('spawns a new session end to end and tears it down with directory deletion', async () => {
    const reply = await router.route('/spawn newbie');
    expect(reply).toContain('Spawned newbie');
    expect(sessions.has('newbie')).toBe(true);
    const spawnedDir = join(baseDir, 'spawned', 'newbie');
    expect(existsSync(spawnedDir)).toBe(true);

    const teardown = await router.route('/teardown newbie --delete');
    expect(teardown).toContain('newbie deregistered');
    expect(teardown).toContain('Directory deleted');
    expect(existsSync(spawnedDir)).toBe(false);
    expect(sessions.has('newbie')).toBe(false);
  });

  it('spawns from a registered template through the short flag', async () => {
    const source = join(baseDir, 'template-source');
    mkdirSync(source);
    git(source, 'init', '-b', 'main');
    writeFileSync(join(source, 'README.md'), 'template content\n');
    writeFileSync(join(source, '.agent-marker'), '');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'template baseline');

    const reply = await router.route('/spawn templated -t local');
    expect(reply).toContain('Spawned templated');
    const spawnedDir = join(baseDir, 'spawned', 'templated');
    expect(readFileSync(join(spawnedDir, 'README.md'), 'utf8')).toBe('template content\n');
    expect(git(spawnedDir, 'remote', 'get-url', 'template').trim()).toBe(source);
    expect(sessions.get('templated')?.repo).toBe(spawnedDir);

    await router.route('/teardown templated');
  });

  it('rejects unknown templates and template/worktree combinations before creating a destination', async () => {
    expect(await router.route('/spawn unknown-template --template missing')).toContain("'template' must be one of");
    expect(existsSync(join(baseDir, 'spawned', 'unknown-template'))).toBe(false);

    const combined = await router.route('/spawn combined --template local --worktree ./repo');
    expect(combined).toContain('mutually exclusive');
    expect(existsSync(join(baseDir, 'spawned', 'combined'))).toBe(false);

    const branched = await router.route('/spawn branched-template --template local --branch other');
    expect(branched).toContain('applies only to a worktree');
    expect(existsSync(join(baseDir, 'spawned', 'branched-template'))).toBe(false);
  });

  it('spawns a codex session via --runtime and records it in the config', async () => {
    const reply = await router.route('/spawn codexer --runtime codex');
    expect(reply).toContain('Spawned codexer');
    const config = readFileSync(join(baseDir, 'config', 'sessions', 'codexer.yaml'), 'utf8');
    expect(config).toContain('runtime: codex');
    await router.route('/teardown codexer --delete');
  });

  it('spawns directly into a targeted native conversation with either session ID flag', async () => {
    const long = await router.route('/spawn restored-long --runtime codex --session-id "provider session"');
    expect(long).toContain('Spawned restored-long');
    expect(long).toContain('restored-long continued.');
    expect(codexRuntime.launches.at(-1)?.opts).toMatchObject({
      continueSession: true,
      resumeSessionId: 'provider session',
    });
    expect(backend.paneFor('restored-long')?.launched[0]).toContain('--session-id "provider session"');
    await router.route('/teardown restored-long --delete');

    const short = await router.route('/spawn restored-short -r codex -s provider-session');
    expect(short).toContain('restored-short continued.');
    expect(codexRuntime.launches.at(-1)?.opts.resumeSessionId).toBe('provider-session');
    await router.route('/teardown restored-short --delete');
  });

  it('rejects a missing or empty targeted spawn session ID before creating a workspace', async () => {
    expect(await router.route('/spawn missing-id --session-id')).toContain('Usage: /spawn');
    expect(await router.route('/spawn empty-id --session-id ""')).toContain("'sessionId' must be a non-empty string");
    expect(existsSync(join(baseDir, 'spawned', 'missing-id'))).toBe(false);
    expect(existsSync(join(baseDir, 'spawned', 'empty-id'))).toBe(false);
  });

  it('spawns a native spartan session via -r and round-trips it through YAML', async () => {
    const reply = await router.route('/spawn new-proj -r spartan');
    expect(reply).toContain('Spawned new-proj');
    expect(sessions.get('new-proj')?.runtime).toBe('spartan');
    expect(codexRuntime.launches.at(-1)?.session.runtime).toBe('spartan');
    expect(readFileSync(join(baseDir, 'config', 'sessions', 'new-proj.yaml'), 'utf8')).toContain('runtime: spartan');
    await router.route('/teardown new-proj --delete');
  });

  it('spawns with a persisted arbitrary effort default and applies it immediately', async () => {
    const reply = await router.route('/spawn thinker --effort future-provider-level');
    expect(reply).toContain('Spawned thinker');
    expect(sessions.get('thinker')?.effort).toBe('future-provider-level');
    expect(runtime.launches.at(-1)?.opts.effort).toBe('future-provider-level');
    expect(readFileSync(join(baseDir, 'config', 'sessions', 'thinker.yaml'), 'utf8')).toContain(
      'effort: future-provider-level',
    );
    await router.route('/teardown thinker --delete');
  });

  it('spawns with repeatable external directories and a role prompt', async () => {
    const prompt = join(baseDir, 'roles', 'worker.md');
    mkdirSync(join(baseDir, 'roles'), { recursive: true });
    writeFileSync(prompt, '# Worker role\n');

    const reply = await router.route(
      `/spawn scoped -a ${join(baseDir, 'records')} --add-dir ${join(baseDir, 'shared')} --system-prompt ${prompt}`,
    );

    expect(reply).toContain('Spawned scoped');
    expect(sessions.get('scoped')?.additionalDirs).toEqual([join(baseDir, 'records'), join(baseDir, 'shared')]);
    expect(sessions.get('scoped')?.systemPromptFile).toBe(prompt);
    expect(runtime.launches.at(-1)?.session.additionalDirs).toEqual([
      join(baseDir, 'records'),
      join(baseDir, 'shared'),
    ]);
    expect(runtime.launches.at(-1)?.session.systemPromptFile).toBe(prompt);
    const config = readFileSync(join(baseDir, 'config', 'sessions', 'scoped.yaml'), 'utf8');
    expect(config).toContain('additionalDirs:');
    expect(config).toContain('systemPromptFile:');
    await router.route('/teardown scoped --delete');
  });

  it('normalizes cc to claude-code in spawned session configuration', async () => {
    const reply = await router.route('/spawn cc-short --runtime cc');
    expect(reply).toContain('Spawned cc-short');
    const config = readFileSync(join(baseDir, 'config', 'sessions', 'cc-short.yaml'), 'utf8');
    expect(config).toContain('runtime: claude-code');
    expect(config).not.toContain('runtime: cc\n');
    await router.route('/teardown cc-short --delete');
  });

  it('records an explicit per-session permission policy from either spawn flag', async () => {
    await router.route('/spawn guarded --require-permissions');
    expect(sessions.get('guarded')?.bypassPermissions).toBe(false);
    expect(runtime.launches.at(-1)?.opts.bypassPermissions).toBe(false);
    await router.route('/teardown guarded --delete');

    await router.route('/spawn yolo --bypass-permissions');
    expect(sessions.get('yolo')?.bypassPermissions).toBe(true);
    expect(runtime.launches.at(-1)?.opts.bypassPermissions).toBe(true);
    await router.route('/teardown yolo --delete');
  });

  it('rejects contradictory permission flags', async () => {
    expect(await router.route('/spawn confused --bypass-permissions --require-permissions')).toContain('Usage:');
    expect(sessions.has('confused')).toBe(false);
  });

  it('accepts shorthand flags (-r, -D)', async () => {
    const reply = await router.route('/spawn shorty');
    expect(reply).toContain('Spawned shorty');
    const teardown = await router.route('/teardown shorty -D');
    expect(teardown).toContain('Directory deleted');

    // -r is the runtime short; the harness only wires claude-code, so verify via config.
    await router.route('/spawn shortr -r codex');
    const config = readFileSync(join(baseDir, 'config', 'sessions', 'shortr.yaml'), 'utf8');
    expect(config).toContain('runtime: codex');
    await router.route('/teardown shortr -D');
  });

  it('rejects the removed public prompt flag', async () => {
    expect(await router.route('/spawn prompted --prompt "do work"')).toContain('Usage: /spawn');
    expect(sessions.has('prompted')).toBe(false);
  });

  it('refuses an unknown runtime without creating anything', async () => {
    const reply = await router.route('/spawn oops --runtime banana');
    expect(reply).toContain("'runtime' must be one of: claude-code, cc, codex, spartan");
    expect(sessions.has('oops')).toBe(false);
    expect(existsSync(join(baseDir, 'spawned', 'oops'))).toBe(false);
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

  it('serializes effort values as YAML data, not injectable config (H7)', async () => {
    await router.route('/spawn injected-effort --effort "xhigh\nruntime: evil"');
    const spawned = sessions.get('injected-effort');
    expect(spawned?.runtime).toBe('claude-code');
    expect(spawned?.effort).toContain('xhigh');
  });

  it('refuses to delete directories containing a git repo', async () => {
    await router.route('/spawn gitty');
    mkdirSync(join(baseDir, 'spawned', 'gitty', '.git'), { recursive: true });
    const reply = await router.route('/teardown gitty --delete');
    expect(reply).toContain('Directory kept');
    expect(existsSync(join(baseDir, 'spawned', 'gitty'))).toBe(true);
  });

  it('keeps a dirty worktree registered, then removes it cleanly while retaining its branch', async () => {
    const repo = join(baseDir, 'main-repo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'main\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');

    expect(await router.route(`/spawn worker --worktree ${repo} --branch worker-branch`)).toContain('Spawned worker');
    const worktree = join(baseDir, 'spawned', 'worker');
    expect(sessions.get('worker')?.repo).toBe(worktree);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('worker-branch');
    expect(events.events).toContainEqual({ type: 'workspace.provisioned', session: 'worker', kind: 'worktree' });

    const runtimeData = join(baseDir, 'data', 'sessions', 'worker');
    mkdirSync(runtimeData, { recursive: true });
    writeFileSync(join(runtimeData, 'native-conversation'), 'provider-session\n');

    writeFileSync(join(worktree, 'dirty.txt'), 'do not lose me\n');
    const refused = await router.route('/teardown worker --delete');
    expect(refused).toContain('NOT deregistered');
    expect(sessions.has('worker')).toBe(true);
    expect(existsSync(join(baseDir, 'config', 'sessions', 'worker.yaml'))).toBe(true);
    expect(existsSync(join(worktree, 'dirty.txt'))).toBe(true);

    rmSync(join(worktree, 'dirty.txt'));
    const removed = await router.route('/teardown worker --delete');
    expect(removed).toContain('Worktree removed');
    expect(sessions.has('worker')).toBe(false);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'show-ref', '--verify', 'refs/heads/worker-branch')).toContain('refs/heads/worker-branch');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(runtimeData, 'native-conversation'), 'utf8')).toBe('provider-session\n');
    expect(events.events).toContainEqual({ type: 'workspace.removed', session: 'worker', kind: 'worktree' });
    expect(JSON.stringify(events.events)).not.toContain(worktree);

    const launchesBeforeResume = runtime.launches.length;
    expect(await router.route(`/spawn worker --worktree ${repo} --branch worker-branch -s provider-session`)).toContain(
      'worker continued.',
    );
    expect(runtime.launches).toHaveLength(launchesBeforeResume + 1);
    expect(runtime.launches.at(-1)?.opts).toMatchObject({
      continueSession: true,
      resumeSessionId: 'provider-session',
    });
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('worker-branch');
    expect(events.events).toContainEqual({
      type: 'session.started',
      session: 'worker',
      cause: 'continue',
      runtime: 'claude-code',
    });
    await router.route('/teardown worker --delete');
  });
});
