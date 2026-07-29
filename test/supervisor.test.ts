import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../src/core/supervisor.js';
import type { ChannelAdapter, ChannelHandlers, ChannelMessage } from '../src/channels/types.js';
import { exportEventJournalJsonl, Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';
import { FakeEventSubscriber } from './fakes/fake-subscriber.js';
import { FakeChannel } from './fakes/fake-channel.js';
import type { ConductorIntegration, ConductorIntegrationContext } from '../src/integrations/types.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { ShepherdManager } from '../src/core/shepherd-manager.js';
import { ConductorMcpServer } from '../src/mcp/server.js';

let baseDir: string;
let supervisor: Supervisor | undefined;

class StrictStartChannel implements ChannelAdapter {
  readonly name = 'strict-start';
  readonly sent: ChannelMessage[] = [];
  started = false;

  start(_handlers: ChannelHandlers): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  send(message: ChannelMessage): Promise<void> {
    if (!this.started) throw new Error('notification sent before channel startup completed');
    this.sent.push(message);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.started = false;
    return Promise.resolve();
  }
}

function writeConfig(supervisorYaml: string, sessions: Record<string, string>): void {
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), supervisorYaml);
  for (const [name, content] of Object.entries(sessions)) {
    writeFileSync(join(baseDir, 'config', 'sessions', `${name}.yaml`), content);
  }
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-sup-'));
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  rmSync(baseDir, { recursive: true, force: true });
});

/**
 * Construction smoke test: the full dependency graph must assemble from config
 * alone — wiring mistakes (wrong config slice, circular init) fail here instead
 * of at runtime. No terminal/network side effects before start().
 */
describe('Supervisor construction', () => {
  it('runs a healthy integration with protected identity and reports it even with an empty roster', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {});
    let context: ConductorIntegrationContext | undefined;
    const integration: ConductorIntegration = {
      name: 'water-cooler',
      start: (value) => {
        context = value;
        value.reportHealth({ state: 'healthy' });
      },
      stop: () => undefined,
    };
    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      integrations: [integration],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start();
    expect(context?.stateDir).toBe(join(baseDir, 'data', 'integrations', 'water-cooler'));
    expect(supervisor.integrationStatus()).toMatchObject([
      {
        name: 'water-cooler',
        sender: 'integration:water-cooler',
        state: 'healthy',
      },
    ]);
    expect(supervisor.statusReport()).toContain(
      'No sessions configured.\n\nIntegrations:\n  water-cooler · 🟢 healthy',
    );
  });

  it('isolates integration startup failure from core readiness', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {});
    const stop = vi.fn();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      integrations: [
        {
          name: 'broken',
          start: () => {
            throw new Error('provider unavailable');
          },
          stop,
        },
      ],
      includeConfiguredChannels: false,
      env: {},
    });

    await expect(supervisor.start()).resolves.toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).resolves.toMatchObject({ ok: true });
    expect(supervisor.integrationStatus()).toMatchObject([
      { name: 'broken', state: 'failed', detail: 'Integration failed to start.' },
    ]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps direct Supervisor construction injection-only instead of executing configured modules', async () => {
    const port = await freePort();
    const marker = join(baseDir, 'configured-import.marker');
    const modulePath = join(baseDir, 'configured.mjs');
    writeFileSync(
      modulePath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported');\n` +
        `export default () => ({ name: 'configured', start() {}, stop() {} });\n`,
    );
    writeConfig(`mcp:\n  port: ${String(port)}\nintegrations:\n  - module: ${JSON.stringify(modulePath)}\n`, {});

    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      env: {},
    });
    await supervisor.start();

    expect(supervisor.integrationStatus()).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it('delivers from an integration after start-all through the protected queue', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\nruntime: claude-code\n`,
    });
    const terminal = new FakeTerminalBackend();
    const integration: ConductorIntegration = {
      name: 'water-cooler',
      start: async (context) => {
        const receipt = await context.sendToSession('alpha', 'bulletins changed', {
          idempotencyKey: 'repo:old:new',
        });
        expect(receipt.status).toBe('delivered');
        context.reportHealth({ state: 'healthy' });
      },
      stop: () => undefined,
    };
    supervisor = new Supervisor(baseDir, {
      terminalBackend: terminal,
      runtimes: [new FakeRuntime()],
      integrations: [integration],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start({ startAll: true });
    expect(terminal.paneFor('alpha')?.received).toEqual(['[Integration: water-cooler] bulletins changed']);
  });

  it('aborts integrations and stops Shepherd before protected delivery and MCP teardown', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {});
    const order: string[] = [];
    let context: ConductorIntegrationContext | undefined;
    const originalShepherdStop = ShepherdManager.prototype.stop;
    const originalDeliveryStop = DeliveryQueue.prototype.stop;
    const originalMcpStop = ConductorMcpServer.prototype.stop;
    const shepherdStop = vi.spyOn(ShepherdManager.prototype, 'stop').mockImplementation(async function () {
      order.push('shepherd');
      await originalShepherdStop.call(this);
    });
    const deliveryStop = vi.spyOn(DeliveryQueue.prototype, 'stop').mockImplementation(function () {
      order.push('delivery');
      originalDeliveryStop.call(this);
    });
    const mcpStop = vi.spyOn(ConductorMcpServer.prototype, 'stop').mockImplementation(async function () {
      order.push('mcp');
      await originalMcpStop.call(this);
    });
    try {
      supervisor = new Supervisor(baseDir, {
        terminalBackend: new FakeTerminalBackend(),
        integrations: [
          {
            name: 'watcher',
            start: (value) => {
              context = value;
              value.reportHealth({ state: 'healthy' });
            },
            stop: () => {
              expect(context?.signal.aborted).toBe(true);
              order.push('integration');
            },
          },
        ],
        includeConfiguredChannels: false,
        env: {},
      });
      await supervisor.start();
      await supervisor.stop();
      supervisor = undefined;

      expect(order.indexOf('integration')).toBeLessThan(order.indexOf('shepherd'));
      expect(order.indexOf('shepherd')).toBeLessThan(order.indexOf('delivery'));
      expect(order.indexOf('shepherd')).toBeLessThan(order.indexOf('mcp'));
    } finally {
      shepherdStop.mockRestore();
      deliveryStop.mockRestore();
      mcpStop.mockRestore();
    }
  });

  it('serves a dynamic fleet runbook topic through the real MCP HTTP surface', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {});
    const bundle = join(baseDir, 'runbooks', 'team', 'workflow');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'README.md'), '# Fleet workflow\n\nLoaded over MCP.\n');
    writeFileSync(
      join(bundle, 'runbook.yaml'),
      'schemaVersion: 1\nid: team/workflow\nname: Team Workflow\nversion: 1.0.0\nsummary: A local workflow.\nrequires:\n  conductor: ">=0.1.0"\ntopics:\n  - id: overview\n    title: Fleet workflow\n    summary: Start here.\n    path: README.md\nresources: []\n',
    );
    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      env: {},
    });
    await supervisor.start();
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp/reader`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_conductor_docs', arguments: { topic: 'runbook:team/workflow/overview' } },
      }),
    });
    const rpc = (await response.json()) as { result: { content: { text: string }[] } };
    const documentation = JSON.parse(rpc.result.content[0]?.text ?? '{}') as { content?: string };
    expect(documentation.content).toContain('Loaded over MCP');

    const forbiddenResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp/reader`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'adopt_runbook',
          arguments: { runbookId: 'team/workflow', version: '1.0.0', topic: 'overview' },
        },
      }),
    });
    const forbidden = (await forbiddenResponse.json()) as { error?: { code?: number; message?: string } };
    expect(forbidden.error).toEqual({ code: -32602, message: 'Unknown tool: adopt_runbook' });
  });

  it('feeds a boot-complete ordered event stream to an injected subscriber without blocking control flow', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const terminal = new FakeTerminalBackend();
    const survivingPane = await terminal.createPane('alpha', 'pane', baseDir);
    terminal.panes.get(survivingPane.id)!.sessionActive = true;
    terminal.survivors.set('alpha', survivingPane);
    const subscriber = new FakeEventSubscriber();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: terminal,
      eventSubscribers: [subscriber],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start();
    await until(() => subscriber.events.some((event) => event.type === 'session.started'));
    const registeredAt = subscriber.events.findIndex((event) => event.type === 'session.registered');
    const startedAt = subscriber.events.findIndex((event) => event.type === 'session.started');
    expect(registeredAt).toBe(0);
    expect(startedAt).toBeGreaterThan(registeredAt);
    expect(subscriber.events[startedAt]).toMatchObject({
      type: 'session.started',
      session: 'alpha',
      cause: 'adopt',
    });

    // Repeated runtime working signals are a storm-prone path. The state choke
    // point emits only the initial stopped -> working transition.
    await fetch(`http://127.0.0.1:${String(port)}/events/alpha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
    });
    await fetch(`http://127.0.0.1:${String(port)}/events/alpha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
    });
    await until(() => subscriber.events.some((event) => event.type === 'session.ready'));
    expect(subscriber.events.filter((event) => event.type === 'session.activity.changed')).toHaveLength(1);
  });

  it('routes an idle post-compaction prompt to supervision without typing into the worker', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\nhealth:\n  idleConfirmMs: 0\ndefaults:\n  auto: true\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const terminal = new FakeTerminalBackend();
    const pane = await terminal.createPane('alpha', 'pane', baseDir);
    terminal.panes.get(pane.id)!.sessionActive = true;
    terminal.setPaneContent(pane.id, 'compaction complete\n❯ ');
    terminal.survivors.set('alpha', pane);
    const channel = new StrictStartChannel();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: terminal,
      channels: [channel],
      includeConfiguredChannels: false,
      env: {},
    });
    await supervisor.start();

    const postEvent = async (body: unknown): Promise<void> => {
      await fetch(`http://127.0.0.1:${String(port)}/events/alpha`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    };
    await postEvent({ hook_event_name: 'PreCompact', transcript_path: '/tmp/transcript.jsonl' });
    expect(channel.sent).toEqual([]);

    await postEvent({ hook_event_name: 'SessionStart', source: 'compact' });
    await until(() => channel.sent.some((message) => message.text.includes('stalled (compaction)')));

    expect(supervisor.statusReport('alpha')).toContain('"activity": "idle"');
    expect(terminal.panes.get(pane.id)?.received).toEqual([]);
  });

  it('tells the operator when a sentinel stops accepting messages', async () => {
    // Shown firing, not assumed: a seat holding a selection prompt cannot
    // receive, and stall routing reaches the sentinel as ordinary messages — so
    // a silent backlog there means fleet-wide supervision is down while every
    // status field still reads healthy.
    const port = await freePort();
    writeConfig(
      `mcp:\n  port: ${String(port)}\nsupervisor:\n  heartbeatIntervalSeconds: 1\nmessaging:\n  sentinelUndeliverableWarnMs: 0\nsentinel:\n  codename: watch\n`,
      {
        alpha: `codename: alpha\nrepo: ${baseDir}\n`,
        watch: `codename: watch\nrepo: ${baseDir}\n`,
      },
    );
    const terminal = new FakeTerminalBackend();
    const pane = await terminal.createPane('watch', 'pane', baseDir);
    terminal.panes.get(pane.id)!.sessionActive = true;
    // Verbatim shape of the frame that wedged a real sentinel.
    terminal.setPaneContent(pane.id, ['  4. Type something.', 'Enter to select · Esc to cancel', '  ❯ '].join('\n'));
    terminal.survivors.set('watch', pane);
    const channel = new StrictStartChannel();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: terminal,
      channels: [channel],
      includeConfiguredChannels: false,
      env: {},
    });
    await supervisor.start();

    await supervisor.command('/tell watch a stall you will never see');

    await until(() =>
      channel.sent.some((message) => message.text.includes('Sentinel watch is not accepting messages')),
    );
    const alarm = channel.sent.find((message) => message.text.includes('not accepting messages'))?.text ?? '';
    expect(alarm).toContain('prompt-open');
    expect(alarm).toContain('fleet-wide stall routing is not being delivered');
    // Never typed into the open prompt.
    expect(terminal.panes.get(pane.id)?.received).toEqual([]);
  });

  it('publishes operator attachment to subscribers without exposing it to sessions', async () => {
    // Whether a human is listening decides what deferring to one costs. It is a
    // condition to record, not a fact to hand the subject: a session that could
    // read it would change its behaviour on the basis of the measurement.
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, { alpha: `codename: alpha\nrepo: ${baseDir}\n` });
    const subscriber = new FakeEventSubscriber();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      eventSubscribers: [subscriber],
      includeConfiguredChannels: false,
      env: {},
    });
    await supervisor.start();

    await until(() => subscriber.events.some((event) => event.type === 'operator.attachment.changed'));
    const attachment = subscriber.events.find((event) => event.type === 'operator.attachment.changed');
    expect(attachment).toMatchObject({ attached: false, surfaces: [], lastInteractionAt: null });

    // An operator command is an interaction; the fact stays out of every
    // session-readable surface.
    await supervisor.command('/status');
    expect(supervisor.statusReport()).not.toContain('attach');
    expect(supervisor.statusReport('alpha')).not.toContain('attach');
  });

  it('reports journal degradation while lifecycle and live subscribers continue', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const subscriber = new FakeEventSubscriber();
    const append = vi.spyOn(Store.prototype, 'appendEvent').mockImplementation(() => {
      throw new Error('simulated journal failure at a private path');
    });
    try {
      supervisor = new Supervisor(baseDir, {
        terminalBackend: new FakeTerminalBackend(),
        eventSubscribers: [subscriber],
        includeConfiguredChannels: false,
        env: {},
      });
      await supervisor.start();
      expect(await supervisor.command('/start alpha')).toBe('alpha started.');
      await until(() => subscriber.events.some((event) => event.type === 'session.started'));
      const status = supervisor.statusReport();
      expect(status).toContain('Event journal DEGRADED');
      expect(status).not.toContain('private path');
    } finally {
      append.mockRestore();
    }
  });

  it('journals restart cancellation as a distinct mechanical message reason', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
    });
    const seed = new Store(join(baseDir, 'data', 'conductor.db'));
    seed.insertDirectMessage('alpha', 'beta', 'stale secret');
    seed.close();
    const subscriber = new FakeEventSubscriber();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      eventSubscribers: [subscriber],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start();
    await until(() => subscriber.events.some((event) => event.type === 'message.cancelled'));
    const cancelled = subscriber.events.find((event) => event.type === 'message.cancelled');
    expect(cancelled).toMatchObject({
      type: 'message.cancelled',
      receiptId: 1,
      sender: 'alpha',
      recipient: 'beta',
      reason: 'conductor-restarted',
    });
    expect(JSON.stringify(cancelled)).not.toContain('stale secret');
  });

  it('routes operator-only runbook adoption identically through an injected channel', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {
      manager: `codename: manager\nrepo: ${baseDir}\n`,
    });
    const bundle = join(baseDir, 'runbooks', 'team', 'workflow');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'README.md'), '# Workflow\n');
    writeFileSync(
      join(bundle, 'runbook.yaml'),
      'schemaVersion: 1\nid: team/workflow\nname: Team Workflow\nversion: 1.0.0\nsummary: Test.\nrequires:\n  conductor: ">=0.1.0"\ntopics:\n  - id: overview\n    title: Overview\n    summary: Start.\n    path: README.md\nresources: []\n',
    );
    const channel = new FakeChannel();
    const events = new FakeEventSubscriber();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      channels: [channel],
      eventSubscribers: [events],
      includeConfiguredChannels: false,
      env: {},
    });
    await supervisor.start();

    const reply = await channel.command('runbook', [
      'adopt',
      'team/workflow',
      '--version',
      '1.0.0',
      '--topic',
      'overview',
      '--session',
      'manager=engineering-manager',
    ]);
    expect(reply).toMatch(/^Adopted team\/workflow@1\.0\.0 topic 'overview' as [0-9a-f-]+\.$/u);
    await until(() => events.events.some((event) => event.type === 'runbook.adopted'));
    expect(events.events.find((event) => event.type === 'runbook.adopted')).toMatchObject({
      runbookId: 'team/workflow',
      sessions: [{ codename: 'manager', role: 'engineering-manager' }],
    });
    const journal = [...exportEventJournalJsonl(join(baseDir, 'data', 'conductor.db'))].map(
      (line) => JSON.parse(line) as { type?: string; runbookId?: string },
    );
    expect(journal).toContainEqual(expect.objectContaining({ type: 'runbook.adopted', runbookId: 'team/workflow' }));
  });

  it('selects an injected runtime from fleet config and exposes it through lifecycle commands', async () => {
    writeConfig('defaults:\n  runtime: external\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const runtime = new FakeRuntime('external');
    const terminal = new FakeTerminalBackend();
    supervisor = new Supervisor(baseDir, { runtimes: [runtime], terminalBackend: terminal });

    expect(await supervisor.command('/start alpha')).toBe('alpha started.');
    expect(runtime.prepared).toHaveLength(1);
    expect(runtime.launches[0]?.session.runtime).toBe('external');
    expect(await supervisor.command('/help')).toContain('cc|claude-code|codex|external');
  });

  it('lets one injected runtime deliberately replace a built-in by name', async () => {
    writeConfig('defaults:\n  runtime: codex\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const replacement = new FakeRuntime('codex');
    supervisor = new Supervisor(baseDir, { runtimes: [replacement], terminalBackend: new FakeTerminalBackend() });

    expect(await supervisor.command('/start alpha')).toBe('alpha started.');
    expect(replacement.launches).toHaveLength(1);
  });

  it('rejects duplicate injected names and unknown configured runtimes with actionable errors', () => {
    writeConfig('defaults:\n  runtime: missing\n', {});
    expect(() => new Supervisor(baseDir, { runtimes: [new FakeRuntime('one'), new FakeRuntime('one')] })).toThrow(
      "Duplicate injected runtime name 'one'",
    );
    expect(() => new Supervisor(baseDir, { runtimes: [new FakeRuntime('one')] })).toThrow(
      "Fleet default selects unknown runtime 'missing'. Registered runtimes: claude-code, codex, one.",
    );
  });

  it('assembles the full graph from a tmux config and reports status', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43391\nsentinel:\n  codename: watch\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      watch: `codename: watch\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);

    const status = supervisor.statusReport();
    expect(status).toMatch(/^Agent Conductor Status\n/);
    expect(status).toContain('Sessions:');
    expect(status).toContain('alpha');
    expect(status).toContain('watch');
    expect(status).toContain('🛡'); // sentinel marker
    expect(status).not.toContain('PR Shepherd');
    expect(supervisor.shepherdStatus()).toMatchObject({ state: 'disabled', presentation: 'headless' });
  });

  it('assembles with the iTerm backend and never nags about a missing sentinel', () => {
    writeConfig('terminal:\n  backend: iterm\nmcp:\n  port: 43392\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).not.toContain('sentinel');
  });

  it('keeps the core available when Telegram is enabled without both credentials', async () => {
    const port = await freePort();
    writeConfig(
      `terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\nchannels:\n  telegram:\n    enabled: true\n`,
      {},
    );
    supervisor = new Supervisor(baseDir, { env: {} });
    await supervisor.start();
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).resolves.toMatchObject({ ok: true });
  });

  it('keeps the core available when Slack is enabled without its credentials', async () => {
    const port = await freePort();
    writeConfig(
      `terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\nchannels:\n  slack:\n    enabled: true\n`,
      {},
    );
    supervisor = new Supervisor(baseDir, { env: {} });
    await supervisor.start();
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).resolves.toMatchObject({ ok: true });
  });

  it('keeps the core available and reports remediation when the optional Shepherd profile is missing', async () => {
    const port = await freePort();
    writeConfig(`terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\nshepherd:\n  enabled: true\n`, {});
    supervisor = new Supervisor(baseDir, { env: {} });
    await supervisor.start();
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).resolves.toMatchObject({ ok: true });
    const shepherd = supervisor.shepherdStatus();
    expect(shepherd.state).toBe('config-invalid');
    expect(shepherd.detail).toContain('pr-shepherd init -C <fleetDir> or conductor start');
  });

  it('isolates a channel startup failure and exposes health only after it settles', async () => {
    const port = await freePort();
    writeConfig(`terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\n`, {});
    const first = new ControlledChannel('first');
    let releaseFailure: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const failure = new ControlledChannel(
      'failure',
      new Error('Slack preflight failed'),
      undefined,
      async () => failureGate,
    );
    supervisor = new Supervisor(baseDir, {
      channels: [first, failure],
      includeConfiguredChannels: false,
      env: {},
    });

    const starting = supervisor.start();
    await until(() => failure.startCount === 1);
    await expect(conductorReachable(port)).resolves.toBe(false);
    releaseFailure?.();
    await starting;
    expect(first.stopCount).toBe(0);
    expect(failure.stopCount).toBe(1);
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).resolves.toMatchObject({ ok: true });
  });

  it('fans operator notifications out concurrently across adapters', async () => {
    const port = await freePort();
    writeConfig(`terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    let releaseSlow: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = new ControlledChannel('slow', undefined, async () => blocked);
    const fast = new ControlledChannel('fast');
    supervisor = new Supervisor(baseDir, {
      channels: [slow, fast],
      includeConfiguredChannels: false,
      env: {},
    });
    await supervisor.start();

    const response = fetch(`http://127.0.0.1:${String(port)}/mcp/alpha`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_to_operator', arguments: { message: 'Ready?' } },
      }),
    });
    await until(() => fast.sent.length === 1);
    expect(slow.sent).toHaveLength(1);
    releaseSlow?.();
    expect((await response).status).toBe(200);
  });

  it('reports NOT delivered when every operator send fails', async () => {
    const port = await freePort();
    writeConfig(`terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const broken = new ControlledChannel('broken', undefined, async () => {
      throw new Error('transport unavailable');
    });
    supervisor = new Supervisor(baseDir, {
      channels: [broken],
      includeConfiguredChannels: false,
      env: {},
    });
    await supervisor.start();

    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp/alpha`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_to_operator', arguments: { message: 'Important update' } },
      }),
    });
    const payload = (await response.json()) as { result: { content: { text: string }[] } };
    expect(payload.result.content[0]?.text).toMatch(/^NOT delivered:/);
  });

  it('constructs configured channels when fleet credentials override inherited values', () => {
    writeConfig('terminal:\n  backend: tmux\nchannels:\n  telegram:\n    enabled: true\n', {});
    writeFileSync(join(baseDir, '.env'), 'CONDUCTOR_TELEGRAM_TOKEN=file-token\nCONDUCTOR_TELEGRAM_CHAT_ID=file-chat\n');
    supervisor = new Supervisor(baseDir, {
      env: { CONDUCTOR_TELEGRAM_TOKEN: 'inherited-token', CONDUCTOR_TELEGRAM_CHAT_ID: 'inherited-chat' },
    });
    expect(supervisor.config.channels.telegram.enabled).toBe(true);
  });

  it('bypasses bundled channel discovery while retaining deterministic environment detection', () => {
    writeConfig('channels:\n  telegram:\n    enabled: true\n', {});
    supervisor = new Supervisor(baseDir, {
      env: { TMUX: 'socket,1,0' },
      includeConfiguredChannels: false,
    });
    expect(supervisor.config.terminal.backend).toBe('tmux');
  });

  it('applies a Codex default runtime to sessions that omit runtime', () => {
    writeConfig(
      'terminal:\n  backend: iterm\nmcp:\n  port: 43390\ndefaults:\n  runtime: codex\nruntimes:\n  codex:\n    defaultModel: gpt-5.6-sol\n    defaultEffort: xhigh\n',
      {
        alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      },
    );
    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).toContain('alpha - codex ·');
    expect(supervisor.statusReport('alpha')).toContain('"runtime": "codex"');
    expect(supervisor.statusReport('alpha')).toContain('"model": "gpt-5.6-sol"');
    expect(supervisor.statusReport('alpha')).toContain('"effort": "xhigh"');
  });

  it('reports the configured path and current branch in detailed and fleet status', () => {
    const repo = join(baseDir, 'session-repo');
    mkdirSync(repo);
    const gitEnv = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) {
      delete gitEnv[key];
    }
    execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'ignore', env: gitEnv });
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43390\n', {
      alpha: `codename: alpha\nrepo: ${repo}\n`,
    });
    supervisor = new Supervisor(baseDir);

    const detailed = JSON.parse(supervisor.statusReport('alpha')) as { path: unknown; branch: unknown };
    expect(detailed.path).toBe(repo);
    expect(detailed.branch).toBe('main');
    expect(supervisor.statusReport()).toContain(`path: ${repo} · branch: main`);
  });

  it('reports freshly reconciled foreground-process truth in detailed status', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43391\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const terminal = new FakeTerminalBackend();
    supervisor = new Supervisor(baseDir, { terminalBackend: terminal });
    await supervisor.command('/start alpha');

    const running = JSON.parse(await supervisor.command('/status alpha')) as {
      processActive: unknown;
      processObservedAt: unknown;
    };
    expect(running.processActive).toBe(true);
    expect(running.processObservedAt).toBeTypeOf('string');

    const pane = terminal.paneFor('alpha');
    expect(pane).toBeDefined();
    terminal.endSession([...terminal.panes.entries()].find(([, value]) => value === pane)?.[0] ?? 'missing');
    const stopped = JSON.parse(await supervisor.command('/status alpha')) as { processActive: unknown };
    expect(stopped.processActive).toBe(false);
  });

  it('repairs stale activity in both directions during an on-demand status reconciliation', async () => {
    const runtime = new FakeRuntime('claude-code');
    runtime.activityState = 'working';
    writeConfig('health:\n  idleConfirmMs: 0\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      runtimes: [runtime],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.command('/start alpha');
    expect(supervisor.statusReport('alpha')).toContain('"activity": "working"');

    runtime.activityState = 'idle';
    expect(await supervisor.command('/status alpha')).toContain('"activity": "idle"');

    runtime.activityState = 'working';
    expect(await supervisor.command('/status alpha')).toContain('"activity": "working"');
  });

  it('routes operator commands through the shared router', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43393\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);

    expect(await supervisor.command('/help')).toContain('/status');
    expect(await supervisor.command('/start ghost')).toBe('Unknown session: ghost');
    expect(await supervisor.command('/tag alpha smoke test')).toContain('smoke test');
    expect(await supervisor.command('/auto alpha')).toBe('alpha: auto on');
    expect(supervisor.statusReport('alpha')).toContain('"auto": true');
  });

  it('wires the configured tag limit through the canonical command surface', async () => {
    writeConfig('supervisor:\n  maxTagLength: 5\nterminal:\n  backend: tmux\nmcp:\n  port: 43392\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);

    await expect(supervisor.command('/tag alpha short')).resolves.toContain('short');
    await expect(supervisor.command('/tag alpha longer')).resolves.toBe("'tag' must be at most 5 characters");
    expect(supervisor.statusReport('alpha')).toContain('"tag": "short"');
  });

  it('persists session state across supervisor instances (single SQLite store)', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43394\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    await supervisor.command('/auto alpha');
    await supervisor.command('/tag alpha carry-over');
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    const status = supervisor.statusReport('alpha');
    expect(status).toContain('"auto": true');
    expect(status).toContain('"tag": "carry-over"');
  });

  it('persists the fleet-watch toggle across supervisor instances', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43394\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    // Nothing is running, so the setting persists as ON while the instrument
    // reports honestly that it cannot currently fire.
    expect(await supervisor.command('/fleet-watch')).toContain('Fleet watch on but');
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).toContain('Fleet watch on but');
    expect(await supervisor.command('/fleet-watch')).toBe('Fleet watch off.');
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).toMatch(/^Agent Conductor Status\n/);
    expect(supervisor.statusReport()).not.toContain('Fleet watch');
  });

  it('migrates an existing named fleet watch to the fleet-wide toggle', () => {
    writeConfig('terminal:\n  backend: tmux\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
    });
    const store = new Store(join(baseDir, 'data', 'conductor.db'));
    store.setWorkspaceValue('sentinel.fleetWatches', [
      { name: 'legacy', sessions: ['alpha', 'beta'], thresholdSeconds: 60 },
    ]);
    store.close();

    supervisor = new Supervisor(baseDir);

    expect(supervisor.statusReport()).toContain('Fleet watch on but');
  });

  it('persists a tool-set sentinel override and a cleared designation', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43398\nsentinel:\n  codename: watch\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      watch: `codename: watch\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    supervisor.setSentinel('alpha');
    expect(supervisor.statusReport('alpha')).toContain('"isSentinel": true');
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport('alpha')).toContain('"isSentinel": true');
    expect(supervisor.statusReport('watch')).toContain('"isSentinel": false');
    supervisor.setSentinel(undefined);
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).not.toContain('🛡');
  });

  it('keeps persisted state when a config transiently fails to parse (M13)', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43396\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    await supervisor.command('/auto alpha');

    // Simulate an editor's mid-write atomic save: the file exists but is invalid.
    writeFileSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'), 'codename: alpha\nrepo:\n  - bad');
    await supervisor.command('/status'); // any op; the reload runs on the watcher, so force one:
    supervisor.reloadSessionsForTest();

    expect(supervisor.statusReport()).toContain('alpha');
    expect(supervisor.statusReport('alpha')).toContain('"auto": true');
  });

  it('deregisters and clears state when a config is genuinely removed', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43397\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const subscriber = new FakeEventSubscriber();
    supervisor = new Supervisor(baseDir, { eventSubscribers: [subscriber] });
    await supervisor.command('/auto alpha');
    rmSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'));
    supervisor.reloadSessionsForTest();
    expect(supervisor.statusReport()).toContain('No sessions configured');
    await until(() => subscriber.events.length > 0);
    expect(subscriber.events).toContainEqual(
      expect.objectContaining({
        type: 'session.deregistered',
        session: 'alpha',
        cause: 'config-removed',
      }),
    );
  });

  it('distinguishes explicit teardown from a hand-removed config', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43397\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const subscriber = new FakeEventSubscriber();
    supervisor = new Supervisor(baseDir, { eventSubscribers: [subscriber] });

    expect(await supervisor.command('/teardown alpha')).toContain('alpha deregistered.');
    await until(() => subscriber.events.length > 0);
    expect(subscriber.events).toContainEqual(
      expect.objectContaining({
        type: 'session.deregistered',
        session: 'alpha',
        cause: 'teardown',
      }),
    );
  });

  it('keeps fleet watch enabled as registered membership changes', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43394\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
      gamma: `codename: gamma\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    expect(await supervisor.command('/fleet-watch')).toContain('Fleet watch on but');

    rmSync(join(baseDir, 'config', 'sessions', 'gamma.yaml'));
    supervisor.reloadSessionsForTest();

    expect(supervisor.statusReport()).toContain('Fleet watch on but');
    expect(supervisor.statusReport()).toContain('2 standing session(s)');
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).toContain('Fleet watch on but');
    await supervisor.command('/fleet-watch');
    expect(supervisor.statusReport()).not.toContain('Fleet watch');
  });

  it('reconciles surviving panes before a persisted threshold-zero fleet watch evaluates', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\nhealth:\n  fleetStallConfirmMs: 0\n  idleConfirmMs: 0\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
    });
    const store = new Store(join(baseDir, 'data', 'conductor.db'));
    store.setWorkspaceValue('sentinel.fleetWatchEnabled', true);
    store.close();
    const terminal = new FakeTerminalBackend();
    const workingPane = await terminal.createPane('alpha', 'pane', baseDir);
    const idlePane = await terminal.createPane('beta', 'pane', baseDir);
    for (const pane of [workingPane, idlePane]) terminal.panes.get(pane.id)!.sessionActive = true;
    terminal.setPaneContent(workingPane.id, ['live output', '❯', 'Press up to edit queued messages'].join('\n'));
    terminal.setPaneContent(idlePane.id, 'completed output\n❯ ');
    terminal.survivors.set('alpha', workingPane);
    terminal.survivors.set('beta', idlePane);
    const channel = new StrictStartChannel();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: terminal,
      channels: [channel],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start();
    expect(channel.started).toBe(true);
    expect(supervisor.statusReport('alpha')).toContain('"activity": "working"');
    expect(channel.sent.some((message) => message.text.startsWith('🚨 Fleet stalled'))).toBe(false);

    // Both standing seats are up, so the quorum holds; the campaign only counts
    // as dark once the working one is reconciled to idle too.
    terminal.setPaneContent(workingPane.id, 'completed output\n❯ ');
    await supervisor.command('/status alpha');
    await until(() => channel.sent.some((message) => message.text.startsWith('🚨 Fleet stalled')));
  });

  it('does not raise a campaign alert for a roster that is merely switched off', async () => {
    // Quorum is measured over standing seats that are UP. With nothing running
    // there is no campaign to be dark, and status must say so rather than
    // presenting itself as an armed backstop.
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\nhealth:\n  fleetStallConfirmMs: 0\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
    });
    const store = new Store(join(baseDir, 'data', 'conductor.db'));
    store.setWorkspaceValue('sentinel.fleetWatchEnabled', true);
    store.close();
    const channel = new StrictStartChannel();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      channels: [channel],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start();

    expect(channel.sent.some((message) => message.text.startsWith('🚨 Fleet stalled'))).toBe(false);
    const status = supervisor.statusReport();
    expect(status).not.toContain('Agent Conductor Status 🔄');
    expect(status).toContain('Fleet watch on but SUPPRESSED');
    expect(status).toContain('0 running');
  });

  it('classifies a surviving idle composer before persisted fleet watch evaluates', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\nhealth:\n  fleetStallConfirmMs: 0\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
    });
    const store = new Store(join(baseDir, 'data', 'conductor.db'));
    store.setWorkspaceValue('sentinel.fleetWatchEnabled', true);
    store.close();
    const terminal = new FakeTerminalBackend();
    const survivingPane = await terminal.createPane('alpha', 'pane', baseDir);
    const betaPane = await terminal.createPane('beta', 'pane', baseDir);
    for (const pane of [survivingPane, betaPane]) {
      terminal.panes.get(pane.id)!.sessionActive = true;
      terminal.setPaneContent(pane.id, 'completed output\n❯ ');
    }
    terminal.survivors.set('alpha', survivingPane);
    terminal.survivors.set('beta', betaPane);
    const channel = new StrictStartChannel();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: terminal,
      channels: [channel],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start();

    expect(channel.started).toBe(true);
    expect(supervisor.statusReport('alpha')).toContain('"activity": "idle"');
    expect(channel.sent.some((message) => message.text.startsWith('🚨 Fleet stalled'))).toBe(true);
  });

  it('does not classify active surviving runtimes as idle merely because their composers are visible', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\n`, {
      claude: `codename: claude\nrepo: ${baseDir}\nruntime: claude-code\n`,
      codex: `codename: codex\nrepo: ${baseDir}\nruntime: codex\n`,
    });
    const terminal = new FakeTerminalBackend();
    const claudePane = await terminal.createPane('claude', 'pane', baseDir);
    const codexPane = await terminal.createPane('codex', 'pane', baseDir);
    terminal.panes.get(claudePane.id)!.sessionActive = true;
    terminal.panes.get(codexPane.id)!.sessionActive = true;
    terminal.setPaneContent(
      claudePane.id,
      ['long active response', 'more active response', '❯', 'Press up to edit queued messages'].join('\n'),
    );
    terminal.setPaneContent(
      codexPane.id,
      ['• Working (3s)', "› What's on your mind?", '  gpt-5.6 medium · /repo'].join('\n'),
    );
    terminal.survivors.set('claude', claudePane);
    terminal.survivors.set('codex', codexPane);
    supervisor = new Supervisor(baseDir, {
      terminalBackend: terminal,
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start();

    expect(supervisor.statusReport('claude')).toContain('"activity": "working"');
    expect(supervisor.statusReport('codex')).toContain('"activity": "working"');
  });

  it('activates a persisted threshold-zero watch only after start-all launches finish', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\nhealth:\n  fleetStallConfirmMs: 0\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    const store = new Store(join(baseDir, 'data', 'conductor.db'));
    store.setWorkspaceValue('sentinel.fleetWatchEnabled', true);
    store.close();
    const channel = new StrictStartChannel();
    supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      runtimes: [new FakeRuntime('claude-code')],
      channels: [channel],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start({ startAll: true });

    expect(channel.started).toBe(true);
    expect(supervisor.statusReport('alpha')).toContain('"activity": "working"');
    expect(channel.sent.some((message) => message.text.startsWith('🚨 Fleet stalled'))).toBe(false);
  });

  it('routes a threshold-zero fleet alert only after channels are ready', async () => {
    const port = await freePort();
    writeConfig(`mcp:\n  port: ${String(port)}\nhealth:\n  fleetStallConfirmMs: 0\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
    });
    const store = new Store(join(baseDir, 'data', 'conductor.db'));
    store.setWorkspaceValue('sentinel.fleetWatchEnabled', true);
    store.close();
    const terminal = new FakeTerminalBackend();
    const channel = new StrictStartChannel();
    for (const codename of ['alpha', 'beta']) {
      const pane = await terminal.createPane(codename, 'pane', baseDir);
      terminal.panes.get(pane.id)!.sessionActive = true;
      terminal.setPaneContent(pane.id, 'completed output\n❯ ');
      terminal.survivors.set(codename, pane);
    }
    supervisor = new Supervisor(baseDir, {
      terminalBackend: terminal,
      channels: [channel],
      includeConfiguredChannels: false,
      env: {},
    });

    await supervisor.start();
    await until(() => channel.sent.some((message) => message.text.startsWith('🚨 Fleet stalled')));

    expect(channel.started).toBe(true);
  });

  it('groups marker-file repos under the Agents header in status', () => {
    const repo = join(baseDir, 'session-repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.agent-marker'), '');
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43395\n', {
      alpha: `codename: alpha\nrepo: ${repo}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    const status = supervisor.statusReport();
    const agentsAt = status.indexOf('Agents:');
    const sessionsAt = status.indexOf('Sessions:');
    expect(agentsAt).toBeGreaterThanOrEqual(0);
    expect(sessionsAt).toBeGreaterThan(agentsAt);
    expect(status.slice(agentsAt, sessionsAt)).toContain('alpha');
    expect(status.slice(sessionsAt)).toContain('beta');
  });
});

class ControlledChannel implements ChannelAdapter {
  readonly sent: ChannelMessage[] = [];
  startCount = 0;
  stopCount = 0;

  constructor(
    readonly name: string,
    private readonly startError?: Error,
    private readonly onSend?: (message: ChannelMessage) => Promise<void>,
    private readonly onStart?: () => Promise<void>,
  ) {}

  async start(_handlers: ChannelHandlers): Promise<void> {
    this.startCount += 1;
    await this.onStart?.();
    if (this.startError !== undefined) throw this.startError;
  }

  async send(message: ChannelMessage): Promise<void> {
    this.sent.push(message);
    await this.onSend?.(message);
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function conductorReachable(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${String(port)}/health`)).ok;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
