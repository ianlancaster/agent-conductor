import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentConfigs } from '../src/config/loader.js';
import type { AgentConfig } from '../src/config/schema.js';
import { CommandRouter, tokenize } from '../src/core/commands.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { HumanInputBroker } from '../src/core/human-input.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Messaging } from '../src/core/messaging.js';
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
let router: CommandRouter;
let operatorMessages: string[];
let agents: Map<string, AgentConfig>;
let humanInput: HumanInputBroker;

function writeAgentConfig(codename: string): void {
  const repo = join(baseDir, 'repos', codename);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(baseDir, 'config', 'agents', `${codename}.yaml`), `codename: ${codename}\nrepo: ${repo}\n`);
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-cmd-'));
  mkdirSync(join(baseDir, 'config', 'agents'), { recursive: true });
  writeAgentConfig('alpha');
  writeAgentConfig('beta');

  store = new Store(':memory:');
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  states = new AgentStateManager(store, 'facilitated');
  operatorMessages = [];
  agents = loadAgentConfigs(baseDir);

  const delivery = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (agent) => lifecycle.getPane(agent),
    config: { queueDrainMs: 2000, queueMaxAgeMs: 60_000 },
  });

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
    healthReset: () => undefined,
    onStarted: async () => undefined,
  });

  const messaging = new Messaging({
    store,
    delivery,
    states,
    agents: () => agents,
    startAgent: (codename, opts) => lifecycle.start(codename, opts),
    channelSend: async (text) => {
      operatorMessages.push(text);
      return true;
    },
  });

  humanInput = new HumanInputBroker({
    notifyOperator: async (text) => {
      operatorMessages.push(text);
    },
    sentinelCodename: () => undefined,
    isActive: (agent) => states.get(agent)?.sessionActive === true,
    getAutonomy: (agent) => states.getAutonomy(agent),
    deliver: (agent, text) => delivery.deliverOrQueue(agent, text),
  });

  for (const codename of agents.keys()) states.register(codename, false);

  router = new CommandRouter({
    lifecycle,
    messaging,
    humanInput,
    states,
    delivery,
    agents: () => agents,
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
  it('starts, reports already-running, and stops an agent', async () => {
    expect(await router.route('/start alpha')).toBe('alpha started.');
    expect(backend.paneFor('alpha')?.launched[0]).toContain('fake-launch alpha');
    expect(states.get('alpha')?.sessionActive).toBe(true);

    expect(await router.route('/start alpha')).toBe('alpha is already running.');
    expect(await router.route('/stop alpha')).toBe('alpha stopped.');
    expect(states.get('alpha')?.sessionActive).toBe(false);
  });

  it('starts all agents with placement flags', async () => {
    const reply = await router.route('/start all --tab');
    expect(reply).toContain('alpha started.');
    expect(reply).toContain('beta started.');
    expect(backend.paneFor('alpha')?.placement).toBe('tab');
  });

  it('continues with the continue flag in the launch command', async () => {
    await router.route('/continue alpha');
    expect(backend.paneFor('alpha')?.launched[0]).toContain('--continue');
  });

  it('rejects unknown agents', async () => {
    expect(await router.route('/start ghost')).toBe('Unknown agent: ghost');
  });
});

describe('conversation commands', () => {
  it('tell starts a stopped agent with the message as prompt', async () => {
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

  it('agent-shortcut command sets the target and sends', async () => {
    await router.route('/start alpha');
    await router.route('/alpha ship it');
    expect(backend.paneFor('alpha')?.received).toContain('[Message from operator] ship it');
  });

  it('broadcast reaches active agents only', async () => {
    await router.route('/start alpha');
    const reply = await router.route('/broadcast stand-up in 5');
    expect(reply).toBe('Broadcast delivered to 1 agent(s).');
    expect(backend.paneFor('alpha')?.received).toContain('[Broadcast from operator] stand-up in 5');
  });
});

describe('mode commands', () => {
  it('sets autonomy for one or all agents', async () => {
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

  it('routes status with and without an agent', async () => {
    expect(await router.route('/status')).toBe('status:all');
    expect(await router.route('/status alpha')).toBe('status:alpha');
  });
});

describe('spawn and teardown', () => {
  it('spawns a new agent end to end and tears it down with directory deletion', async () => {
    const reply = await router.route('/spawn newbie --prompt "hello world"');
    expect(reply).toContain('Spawned newbie');
    expect(agents.has('newbie')).toBe(true);
    expect(backend.paneFor('newbie')?.launched[0]).toContain('hello world');
    const spawnedDir = join(baseDir, 'spawned', 'newbie');
    expect(existsSync(spawnedDir)).toBe(true);

    const teardown = await router.route('/teardown newbie --delete');
    expect(teardown).toContain('newbie deregistered');
    expect(teardown).toContain('Directory deleted');
    expect(existsSync(spawnedDir)).toBe(false);
    expect(agents.has('newbie')).toBe(false);
  });

  it('rejects a traversal codename before writing any files (H7)', async () => {
    const reply = await router.route('/spawn ../../../etc/evil');
    expect(reply).toContain('Invalid codename');
    expect(existsSync(join(baseDir, '..', '..', '..', 'etc', 'evil'))).toBe(false);
    expect(agents.has('../../../etc/evil')).toBe(false);
  });

  it('serializes model values as YAML data, not injectable config (H7)', async () => {
    // A real newline inside the quoted model value: string interpolation would
    // have injected a `runtime:` key; js-yaml keeps it a single scalar.
    await router.route('/spawn injected --model "sonnet\nruntime: evil"');
    const spawned = agents.get('injected');
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

describe('human input over commands', () => {
  it('answers a pending question via /answer', async () => {
    const pendingAnswer = humanInput.request('alpha', 'Which env?');
    const [pending] = humanInput.listPending();
    const reply = await router.route(`/answer ${pending?.id ?? 0} staging`);
    expect(reply).toBe('Answer delivered to alpha.');
    expect(await pendingAnswer).toBe('staging');
  });

  it('answers via button callback data', async () => {
    const pendingAnswer = humanInput.request('alpha', 'Deploy?', undefined, ['yes', 'no']);
    const [pending] = humanInput.listPending();
    const reply = await router.callback(`hi:${pending?.id ?? 0}:1`);
    expect(reply).toBe('Answer delivered to alpha.');
    expect(await pendingAnswer).toBe('no');
  });
});
