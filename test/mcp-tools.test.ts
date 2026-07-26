import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
let runtime: FakeRuntime;

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
  runtime = new FakeRuntime();
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
    config: { queueDrainMs: 2000 },
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
      defaultEfforts: { 'claude-code': undefined, 'codex': undefined },
      defaultBypassPermissions: true,
      markerFile: '.agent-marker',
      spawnDirPattern: './{codename}',
      spawnTemplates: { agent: { source: 'https://example.invalid/template.git' } },
      templateCloneTimeoutMs: 5_000,
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
    config: {
      captureLines: 40,
      suppressWindowMs: 300_000,
      suppressSimilarity: 0.8,
      sentinelCodename: 'watch',
      fleetStallThresholdSeconds: 15,
    },
    initialSessions: sessions.keys(),
    backend,
    runtimeFor: () => runtime,
    getPane: (a) => lifecycle.getPane(a),
    isAuto: (a) => states.isAuto(a),
    isPaused: (a) => states.isPaused(a),
    isRunning: (a) => states.get(a)?.running === true,
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
    sessions: () => sessions,
    modelHints: { 'claude-code': ['claude-test'], 'codex': ['codex-test', 'custom-provider/model'] },
    effortHints: { 'claude-code': ['low', 'max'], 'codex': ['minimal', 'xhigh', 'ultra'] },
    statusReport: (c) =>
      statusReport(
        {
          sessions: () => sessions,
          getState: (n) => states.get(n),
          runtimeFor: (n) => lifecycle.runtimeNameFor(n),
          modelFor: (n) => sessions.get(n)?.model,
          effortFor: (n) => states.get(n)?.effort ?? sessions.get(n)?.effort,
          sentinelCodename: () => sentinel.sentinelCodename(),
        },
        c,
      ),
    tail: async (c, n) => `tail:${c}:${n}`,
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
      store.setWorkspaceValue('sentinel.codename', codename ?? null);
      sentinel.setSentinel(codename);
    },
    getDocumentation: async (topic) => `docs:${topic ?? 'index'}`,
    runbookAdoptions: {
      adopt: () => 'adopted',
      supersede: () => 'superseded',
      end: () => 'ended',
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
    expect(mcpNames).toContain('get_conductor_docs');
    expect(mcpNames).not.toContain('summon_session');
    expect(mcpNames).not.toContain('respond_to_operator_request');
    expect(mcpNames).not.toContain('adopt_runbook');
    expect(mcpNames).not.toContain('supersede_runbook_adoption');
    expect(mcpNames).not.toContain('end_runbook_adoption');
    expect(operatorNames).toContain('summon_session');
    expect(operatorNames).toContain('respond_to_operator_request');
    expect(operatorNames).toContain('adopt_runbook');
    expect(operatorNames).toContain('supersede_runbook_adoption');
    expect(operatorNames).toContain('end_runbook_adoption');
    expect(operatorNames).not.toContain('whoami');
    expect(operatorNames).not.toContain('get_conductor_docs');
  });

  it('exposes the lazy Conductor handbook to sessions with discoverable topics', async () => {
    const docs = tool('get_conductor_docs');
    const properties = docs.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.topic?.enum).toBeUndefined();
    expect(await docs.handler({}, 'alpha')).toBe('docs:index');
    expect(await docs.handler({ topic: 'supervision' }, 'alpha')).toBe('docs:supervision');
    expect(await docs.handler({ topic: 'runbook:team/workflow/overview' }, 'alpha')).toBe(
      'docs:runbook:team/workflow/overview',
    );
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
    expect(startProperties).toHaveProperty('effort');
    expect(continueProperties).toHaveProperty('runtime');
    expect(continueProperties).toHaveProperty('effort');
    expect((startProperties.runtime as { enum?: string[] }).enum).toEqual(['claude-code', 'cc', 'codex']);
    expect(spawnProperties).not.toHaveProperty('prompt');
    expect(spawnProperties).toHaveProperty('worktreeRepo');
    expect(spawnProperties.template).toMatchObject({
      type: 'string',
      enum: ['agent'],
    });
    expect(spawnProperties).toHaveProperty('branch');
    expect(spawnProperties).toHaveProperty('bypassPermissions');
    expect(spawnProperties).toHaveProperty('effort');
    expect(spawnProperties).toHaveProperty('additionalDirs');
    expect(spawnProperties).toHaveProperty('systemPromptFile');
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

  it('returns inspectable direct-message receipts without exposing them to unrelated sessions', async () => {
    await tool('start_session').handler({ codename: 'beta' }, 'alpha');
    await expect(tool('send_to_session').handler({ codename: 'beta', message: 'hello' }, 'alpha')).resolves.toEqual({
      messageId: 1,
      recipient: 'beta',
      status: 'delivered',
      deduplicated: false,
    });
    const status = JSON.parse(await tool('get_message_status').handler({ messageId: 1 }, 'alpha')) as {
      deliveredAt: unknown;
      lastFlushAttempt: unknown;
    };
    expect(status).toMatchObject({
      id: 1,
      sender: 'alpha',
      recipient: 'beta',
      status: 'delivered',
      flushSkipReason: null,
    });
    expect(status.deliveredAt).toBeTypeOf('string');
    expect(status.lastFlushAttempt).toBeTypeOf('string');
    await expect(tool('get_message_status').handler({ messageId: 1 }, 'beta')).resolves.toContain('"recipient":"beta"');
    await expect(tool('get_message_status').handler({ messageId: 1 }, 'watch')).resolves.toBe(
      'Message #1 was not found or is not part of your conversation. Receipt ids are fleet-wide; this response does not indicate a ledger gap.',
    );
    await expect(tool('get_message_status').handler({ messageId: 1.5 }, 'alpha')).rejects.toThrow(/positive integer/);
  });

  it('cancels only pending outbound receipts', async () => {
    await tool('start_session').handler({ codename: 'beta' }, 'alpha');
    runtime.inputState = 'draft';
    await tool('send_to_session').handler({ codename: 'beta', message: 'queued' }, 'alpha');

    await expect(tool('cancel_message').handler({ messageId: 1 }, 'beta')).resolves.toBe('Message #1 was not found.');
    await expect(tool('cancel_message').handler({ messageId: 1 }, 'alpha')).resolves.toBe('Message #1 cancelled.');
    expect(JSON.parse(await tool('get_message_status').handler({ messageId: 1 }, 'alpha'))).toMatchObject({
      status: 'cancelled',
    });
    await expect(tool('cancel_message').handler({ messageId: 0 }, 'alpha')).rejects.toThrow(/at least 1/);
  });

  it('defines and enforces the idempotent message receipt contract', async () => {
    const properties = tool('send_to_session').inputSchema.properties as Record<string, unknown>;
    expect(properties.idempotencyKey).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Optional sender-scoped key for receipt deduplication',
    });
    await tool('start_session').handler({ codename: 'beta' }, 'alpha');
    const first = await tool('send_to_session').handler(
      { codename: 'beta', message: 'hello', idempotencyKey: 'shepherd:event:beta' },
      'alpha',
    );
    const duplicate = await tool('send_to_session').handler(
      { codename: 'beta', message: 'different', idempotencyKey: 'shepherd:event:beta' },
      'alpha',
    );
    expect(first).toEqual({ messageId: 1, recipient: 'beta', status: 'delivered', deduplicated: false });
    expect(duplicate).toEqual({ messageId: 1, recipient: 'beta', status: 'delivered', deduplicated: true });
    await expect(tool('send_to_session').handler({ codename: 'ghost', message: 'hello' }, 'alpha')).rejects.toThrow(
      'Unknown session: ghost',
    );
    await expect(tool('send_to_session').handler({ codename: 'alpha', message: 'hello' }, 'alpha')).rejects.toThrow(
      'Cannot send a message to yourself',
    );
    await expect(
      tool('send_to_session').handler({ codename: 'beta', message: 'hello', idempotencyKey: 'x'.repeat(129) }, 'alpha'),
    ).rejects.toThrow(/at most 128/);
  });

  it('passes start and continue runtime and effort overrides through MCP', async () => {
    const displayedPath = join('~', 'Projects', 'watch');
    sessions.set('watch', { ...sessionConfig('watch'), repo: join(homedir(), 'Projects', 'watch') });
    expect(
      await tool('start_session').handler(
        { codename: 'watch', runtime: 'codex', effort: 'future-provider-level' },
        'alpha',
      ),
    ).toBe('watch started.');
    expect(states.get('watch')?.runtime).toBe('codex');
    expect(states.get('watch')?.effort).toBe('future-provider-level');
    expect(await tool('list_sessions').handler({}, 'alpha')).toContain('watch - codex');
    expect(await tool('list_sessions').handler({}, 'alpha')).toContain(`path: ${displayedPath}`);
    const status = JSON.parse(await tool('get_session_status').handler({ codename: 'watch' }, 'alpha')) as {
      runtime: unknown;
      effort: unknown;
      path: unknown;
      branch: unknown;
    };
    const identity = JSON.parse(await tool('whoami').handler({}, 'watch')) as { runtime: unknown };
    expect(status.runtime).toBe('codex');
    expect(status.effort).toBe('future-provider-level');
    expect(status.path).toBe(displayedPath);
    expect(status.branch).toBeNull();
    expect(identity.runtime).toBe('codex');
    await tool('stop_session').handler({ codename: 'watch' }, 'alpha');
    expect(
      await tool('continue_session').handler({ codename: 'watch', runtime: 'codex', effort: 'ultra' }, 'alpha'),
    ).toBe('watch continued.');
    expect(states.get('watch')?.runtime).toBe('codex');
    expect(states.get('watch')?.effort).toBe('ultra');
  });

  it('normalizes the cc runtime shorthand through MCP', async () => {
    expect(await tool('start_session').handler({ codename: 'watch', runtime: 'cc' }, 'alpha')).toBe('watch started.');
    expect(states.get('watch')?.runtime).toBe('claude-code');
  });

  it('documents worktree destination and new-branch base semantics on the MCP surface', () => {
    const spawn = tool('spawn_session');
    const properties = spawn.inputSchema.properties as Record<string, { description?: string }>;
    expect(spawn.description).toContain('spawn.dirPattern');
    expect(spawn.description).toContain('current HEAD');
    expect(properties.path?.description).toContain('Destination');
    expect(properties.branch?.description).toContain('current HEAD');
  });

  it('advertises configurable model hints without turning them into validation', () => {
    const spawn = tool('spawn_session');
    const properties = spawn.inputSchema.properties as Record<string, { description?: string; enum?: string[] }>;
    expect(properties.model?.description).toContain('claude-code: claude-test');
    expect(properties.model?.description).toContain('codex: codex-test, custom-provider/model');
    expect(properties.model?.description).toContain('not exhaustive or validated');
    expect(properties.model?.enum).toBeUndefined();
  });

  it('advertises configurable effort hints on every lifecycle surface without validating them', () => {
    for (const name of ['spawn_session', 'start_session', 'continue_session']) {
      const properties = tool(name).inputSchema.properties as Record<string, { description?: string; enum?: string[] }>;
      expect(properties.effort?.description).toContain('claude-code: low, max');
      expect(properties.effort?.description).toContain('codex: minimal, xhigh, ultra');
      expect(properties.effort?.description).toContain('not exhaustive or validated');
      expect(properties.effort?.enum).toBeUndefined();
    }
  });

  it('toggles fleet watch through one argument-free MCP primitive', async () => {
    expect(await tool('toggle_fleet_watch').handler({}, 'unknown')).toBe('Fleet watch on.');
    expect(await tool('toggle_fleet_watch').handler({}, 'alpha')).toBe('Fleet watch off.');
    expect(tools.some((item) => item.name === 'arm_fleet_watch')).toBe(false);
    expect(tools.some((item) => item.name === 'disarm_fleet_watch')).toBe(false);
    expect(tools.some((item) => item.name === 'list_fleet_watches')).toBe(false);
  });

  it('gives every operation and argument a complete canonical description', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const agentGuide = readFileSync(new URL('../docs/agent-guide.md', import.meta.url), 'utf8');
    for (const definition of operations.definitions()) {
      expect(definition.description.trim().length, `${definition.name} has a thin description`).toBeGreaterThan(20);
      expect(definition.resultDescription.trim().length, `${definition.name} needs result semantics`).toBeGreaterThan(
        5,
      );
      for (const [propertyName, property] of Object.entries(definition.inputSchema.properties)) {
        expect(
          property.description?.trim().length,
          `${definition.name}.${propertyName} needs a description`,
        ).toBeGreaterThan(5);
      }
      if (definition.audiences.includes('session')) {
        expect(agentGuide, `${definition.name} missing from the managed-agent handbook`).toContain(definition.name);
      }
    }
    for (const command of buildOperatorCommands(operations)) {
      expect(command.usage, `/${command.command} needs canonical usage`).toMatch(new RegExp(`^/${command.command}`));
      expect(command.description.trim().length, `/${command.command} has a thin description`).toBeGreaterThan(20);
    }
    expect(readme).toContain('[Managed-agent handbook](docs/agent-guide.md)');
    expect(readme).toContain('Run `/help` in the operator console for the');
  });

  it('makes direct messaging the default for peer interaction and restricts tailing', () => {
    const protocol = readFileSync(new URL('../prompts/conductor-protocol.md', import.meta.url), 'utf8');
    expect(protocol).toMatch(/Ask a peer directly[^.]+instead of silently reading its\s+terminal\./u);
    expect(protocol).toContain('`tail_session` is not a substitute for communication');
    expect(protocol).toContain('you already contacted the peer');
    expect(protocol).toContain('operator explicitly asks you to inspect');
    expect(protocol).toContain('Prefer `get_session_status` for non-invasive liveness checks.');
    expect(protocol).toContain('Peer conversation is event-driven.');
    expect(protocol).toMatch(/end your turn;\s+the response will arrive as a new message and activate your next turn/u);
    expect(protocol).toMatch(/Do not create timers, sleep loops, recurring\s+monitors, scheduled checks/u);
    expect(protocol).toContain('never poll the peer');
    expect(operations.definition('tail_session')?.description).toContain(
      'use send_to_session for normal agent conversation and status requests',
    );
  });

  it('keeps every turn-zero invariant inside a bounded mandatory prompt', () => {
    const protocol = readFileSync(new URL('../prompts/conductor-protocol.md', import.meta.url), 'utf8');
    expect(Buffer.byteLength(protocol, 'utf8')).toBeLessThanOrEqual(4_500);
    for (const invariant of [
      'identity is mechanical',
      '[Message from <sender>]',
      '[Broadcast from <sender>]',
      '[Sentinel] <text>',
      'operator authority',
      'Peer conversation is event-driven',
      'signs outgoing messages automatically',
      'type_in_pane',
      "can overwrite an operator's text",
      'get_conductor_docs',
      'fleet environment',
      'never print, quote, summarize, or message its values',
    ]) {
      expect(protocol, `missing turn-zero invariant: ${invariant}`).toContain(invariant);
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
