import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SessionConfig } from '../src/config/schema.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { buildOperatorCommands } from '../src/core/commands.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Messaging } from '../src/core/messaging.js';
import { ConductorOperations } from '../src/core/operations.js';
import { OperatorRequests } from '../src/core/operator-requests.js';
import { StallSentinelRouter } from '../src/core/sentinel.js';
import { SessionStateManager } from '../src/core/state.js';
import { statusReport } from '../src/core/status.js';
import { buildMcpTools } from '../src/mcp/tools.js';
import type { McpToolDefinition } from '../src/mcp/server.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let store: Store;
let states: SessionStateManager;
let sessions: Map<string, SessionConfig>;
let tools: McpToolDefinition[];
let sentinel: StallSentinelRouter;
let operations: ConductorOperations;

function tool(name: string): McpToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

function sessionConfig(codename: string): SessionConfig {
  return { codename, repo: `/tmp/${codename}`, runtime: 'claude-code', additionalDirs: [], schedules: [] };
}

beforeEach(() => {
  store = new Store(':memory:');
  const backend = new FakeTerminalBackend();
  const runtime = new FakeRuntime();
  states = new SessionStateManager(store, false);
  sessions = new Map([
    ['alpha', sessionConfig('alpha')],
    ['beta', sessionConfig('beta')],
    ['watch', sessionConfig('watch')],
  ]);
  const delivery = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (a) => lifecycle.getPane(a),
    isReady: (a) => states.isReady(a),
    config: { queueDrainMs: 2000, queueMaxAgeMs: 60_000 },
  });
  const lifecycle = new Lifecycle({
    store,
    backend,
    states,
    runtimes: new Map([
      ['claude-code', runtime],
      ['codex', runtime],
    ]),
    sessions: () => sessions,
    identityFor: (c) => ({ mcpUrl: '', eventsUrl: '', configDir: `/tmp/${c}` }),
    config: {
      defaultPlacement: 'pane',
      defaultRuntime: 'claude-code',
      defaultBypassPermissions: true,
      markerFile: '.agent-marker',
      spawnDirPattern: './{codename}',
    },
    baseDir: '/tmp',
    sessionConfigDir: '/tmp/sessions',
    reloadSessions: () => undefined,
    supervisionReset: () => undefined,
  });
  const messaging = new Messaging({
    store,
    delivery,
    states,
    sessions: () => sessions,
    startSession: (c, o) => lifecycle.start(c, o),
  });
  const operatorRequests = new OperatorRequests({ store, messaging, channelSend: async () => false });
  sentinel = new StallSentinelRouter({
    config: { captureLines: 40, suppressWindowMs: 300_000, suppressSimilarity: 0.8, sentinelCodename: 'watch' },
    backend,
    runtimeFor: () => runtime,
    getPane: (a) => lifecycle.getPane(a),
    isAuto: (a) => states.isAuto(a),
    isPaused: (a) => states.isPaused(a),
    isActive: (a) => states.get(a)?.running === true,
    deliver: async () => 'delivered',
    notifyOperator: async () => undefined,
    logEvent: () => undefined,
  });

  for (const codename of sessions.keys()) states.register(codename, false);

  operations = new ConductorOperations({
    lifecycle,
    messaging,
    operatorRequests,
    sentinel,
    states,
    delivery,
    sessions: () => sessions,
    statusReport: (c) =>
      statusReport(
        {
          sessions: () => sessions,
          getState: (n) => states.get(n),
          runtimeFor: (n) => lifecycle.runtimeNameFor(n),
          sentinelCodename: () => sentinel.sentinelCodename(),
        },
        c,
      ),
    tail: async (c, n) => `tail:${c}:${n}`,
    tailLimits: { defaultLines: 30, maxLines: 500 },
    fleetStallDefaultSeconds: 300,
    retitle: async () => undefined,
    summon: async (codename) => `summoned:${codename}`,
    banish: async (codename) => `banished:${codename}`,
    setSentinel: (codename) => {
      if (codename !== undefined && !states.has(codename)) throw new Error(`Unknown session: ${codename}`);
      store.setWorkspaceValue('sentinel.codename', codename ?? null);
      sentinel.setSentinel(codename);
    },
  });
  tools = buildMcpTools(operations);
});

describe('surface contract', () => {
  it('renders every shared operation through both MCP and operator adapters', () => {
    const mcpNames = new Set(tools.map((definition) => definition.name));
    const operatorNames = new Set(buildOperatorCommands(operations).flatMap((command) => command.operations));
    const shared = operations
      .definitions()
      .filter((definition) => definition.audiences.includes('operator') && definition.audiences.includes('session'));

    for (const operation of shared) {
      expect(mcpNames.has(operation.name), `${operation.name} missing from MCP`).toBe(true);
      expect(operatorNames.has(operation.name), `${operation.name} missing from operator commands`).toBe(true);
      expect(tool(operation.name).inputSchema).toEqual(operation.inputSchema);
    }
  });

  it('keeps audience-specific operations explicit', () => {
    const mcpNames = tools.map((definition) => definition.name);
    const operatorNames = buildOperatorCommands(operations).flatMap((command) => command.operations);
    expect(mcpNames).toContain('whoami');
    expect(mcpNames).toContain('send_to_operator');
    expect(mcpNames).not.toContain('summon_session');
    expect(mcpNames).not.toContain('respond_to_operator_request');
    expect(operatorNames).toContain('summon_session');
    expect(operatorNames).toContain('respond_to_operator_request');
    expect(operatorNames).not.toContain('whoami');
  });

  it('keeps removed conveniences and duplicate tools out of the MCP surface', () => {
    const names = tools.map((definition) => definition.name);
    expect(names).not.toContain('notify_sessions');
    expect(names).not.toContain('request_restart');
    expect(names).not.toContain('create_worktree');
    expect(names).not.toContain('remove_worktree');
    expect(names).toContain('pause_session');
    expect(names).toContain('resume_session');
    expect(names).toContain('toggle_auto');
    expect(names).not.toContain('set_autonomy');
    expect(names).not.toContain('session_exists');
    expect(names).not.toContain('get_tag');

    const startProperties = tool('start_session').inputSchema.properties as Record<string, unknown>;
    const continueProperties = tool('continue_session').inputSchema.properties as Record<string, unknown>;
    const spawnProperties = tool('spawn_session').inputSchema.properties as Record<string, unknown>;
    expect(startProperties).not.toHaveProperty('prompt');
    expect(startProperties).toHaveProperty('runtime');
    expect(continueProperties).toHaveProperty('runtime');
    expect((startProperties.runtime as { enum?: string[] }).enum).toEqual(['claude-code', 'cc', 'codex']);
    expect(spawnProperties).not.toHaveProperty('prompt');
    expect(spawnProperties).toHaveProperty('worktreeRepo');
    expect(spawnProperties).toHaveProperty('branch');
    expect(spawnProperties).toHaveProperty('bypassPermissions');
  });

  it('validates arguments in the shared layer for every adapter', async () => {
    await expect(tool('start_session').handler({ codename: 'watch', prompt: 'hidden work' }, 'alpha')).rejects.toThrow(
      "Unknown argument 'prompt'",
    );
    await expect(tool('toggle_auto').handler({ codename: 'watch', mode: 'invalid' }, 'alpha')).rejects.toThrow(
      "Unknown argument 'mode'",
    );
  });

  it('exposes selectable send_to_operator choices with bounded string-array validation', async () => {
    const send = tool('send_to_operator');
    expect((send.inputSchema.properties as Record<string, unknown>).options).toEqual({
      type: 'array',
      description: 'Optional choices for the operator to select (1–8 unique choices)',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 80 },
    });

    await expect(send.handler({ message: 'Choose', options: ['one', 'two'] }, 'alpha')).resolves.toMatch(
      /^NOT delivered:/,
    );
    expect(store.getOperatorRequest(1)).toMatchObject({ session: 'alpha', options: ['one', 'two'] });
    await expect(send.handler({ message: 'Choose', options: [] }, 'alpha')).rejects.toThrow(/at least 1/);
    await expect(send.handler({ message: 'Choose', options: ['ok', 2] }, 'alpha')).rejects.toThrow(/items/);
    await expect(send.handler({ message: 'Choose', options: Array(9).fill('x') }, 'alpha')).rejects.toThrow(
      /at most 8/,
    );
    await expect(send.handler({ message: 'Choose', options: [''] }, 'alpha')).rejects.toThrow(/non-empty/);
    await expect(send.handler({ message: 'Choose', options: ['x'.repeat(81)] }, 'alpha')).rejects.toThrow(/at most 80/);
    await expect(send.handler({ message: 'Choose', options: ['same', ' same '] }, 'alpha')).rejects.toThrow(/unique/);
  });

  it('passes start and continue runtime overrides through MCP', async () => {
    expect(await tool('start_session').handler({ codename: 'watch', runtime: 'codex' }, 'alpha')).toBe(
      'watch started.',
    );
    expect(states.get('watch')?.runtime).toBe('codex');
    expect(await tool('list_sessions').handler({}, 'alpha')).toContain('watch - codex');
    const status = JSON.parse(await tool('get_session_status').handler({ codename: 'watch' }, 'alpha')) as {
      runtime: unknown;
    };
    const identity = JSON.parse(await tool('whoami').handler({}, 'watch')) as { runtime: unknown };
    expect(status.runtime).toBe('codex');
    expect(identity.runtime).toBe('codex');
    await tool('stop_session').handler({ codename: 'watch' }, 'alpha');
    expect(await tool('continue_session').handler({ codename: 'watch', runtime: 'codex' }, 'alpha')).toBe(
      'watch continued.',
    );
    expect(states.get('watch')?.runtime).toBe('codex');
  });

  it('normalizes the cc runtime shorthand through MCP', async () => {
    expect(await tool('start_session').handler({ codename: 'watch', runtime: 'cc' }, 'alpha')).toBe('watch started.');
    expect(states.get('watch')?.runtime).toBe('claude-code');
  });

  it('arms and inspects fleet watches through MCP', async () => {
    expect(
      await tool('arm_fleet_watch').handler({ name: 'pair', sessions: 'alpha,beta', thresholdSeconds: 0 }, 'unknown'),
    ).toContain("'pair' armed");
    expect(await tool('list_fleet_watches').handler({}, 'alpha')).toContain('pair · watching');
    expect(await tool('disarm_fleet_watch').handler({ name: 'pair' }, 'alpha')).toContain('disarmed');
  });

  it('documents every shared operation and every session-facing tool', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const protocol = readFileSync(new URL('../prompts/conductor-protocol.md', import.meta.url), 'utf8');
    for (const definition of operations.definitions()) {
      if (definition.audiences.includes('operator') && definition.audiences.includes('session')) {
        expect(readme, `${definition.name} missing from README`).toContain(definition.name);
      }
      if (definition.audiences.includes('session')) {
        expect(readme, `${definition.name} missing from README`).toContain(definition.name);
        expect(protocol, `${definition.name} missing from protocol prompt`).toContain(definition.name);
      }
    }
    for (const command of buildOperatorCommands(operations)) {
      expect(readme, `/${command.command} missing from README`).toContain(`/${command.command}`);
    }
  });
});

afterEach(() => {
  store.close();
});

describe('whoami', () => {
  it('reports the calling session’s own codename and status', async () => {
    states.toggleAuto('alpha');
    states.setTag('alpha', 'refactor');
    const out = JSON.parse(await tool('whoami').handler({}, 'alpha')) as Record<string, unknown>;
    expect(out.codename).toBe('alpha');
    expect(out.registered).toBe(true);
    expect(out.isSentinel).toBe(false);
    expect(out.auto).toBe(true);
    expect(out.tag).toBe('refactor');
  });

  it('reflects the mechanical caller, so two sessions get different answers from the same tool', async () => {
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
    expect(out.running).toBe(false);
    expect(out.auto).toBeNull();
  });

  it('takes no arguments and rejects unknown properties', () => {
    const def = tool('whoami');
    expect(def.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });
});

describe('set_sentinel', () => {
  it('designates a registered session immediately and persists the choice', async () => {
    expect(await tool('set_sentinel').handler({ codename: 'alpha' }, 'watch')).toBe('alpha set as stall sentinel.');
    expect(sentinel.sentinelCodename()).toBe('alpha');
    expect(store.getWorkspaceValue('sentinel.codename')).toBe('alpha');
    const identity = JSON.parse(await tool('whoami').handler({}, 'alpha')) as { isSentinel: boolean };
    expect(identity.isSentinel).toBe(true);
  });

  it('clears the sentinel when codename is omitted', async () => {
    expect(await tool('set_sentinel').handler({}, 'alpha')).toBe('Stall sentinel cleared.');
    expect(sentinel.sentinelCodename()).toBeUndefined();
    expect(store.getWorkspaceValue('sentinel.codename')).toBeNull();
  });

  it('rejects an unknown session', async () => {
    await expect(tool('set_sentinel').handler({ codename: 'ghost' }, 'alpha')).rejects.toThrow(
      'Unknown session: ghost',
    );
    expect(sentinel.sentinelCodename()).toBe('watch');
  });
});
