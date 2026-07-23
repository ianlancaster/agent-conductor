import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelAdapter, ChannelHandlers, ChannelMessage } from '../src/channels/types.js';
import { Supervisor } from '../src/core/supervisor.js';
import type { FederationMessageReceipt, PeerDirectoryEntry } from '../src/federation/types.js';
import { Store } from '../src/store/index.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let root: string;
let supervisors: Supervisor[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conductor-federation-integration-'));
  supervisors = [];
});

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  rmSync(root, { recursive: true, force: true });
});

describe('local federation over real HTTP', () => {
  it('discovers qualified peers and exchanges durable messages without starting stopped recipients', async () => {
    const registryDir = join(root, 'registry');
    const fleetA = join(root, 'fleet-a-dir');
    const fleetB = join(root, 'fleet-b-dir');
    const portA = await freePort();
    const portB = await freePort();
    writeFleet(fleetA, 'fleet-a', portA, registryDir);
    writeFleet(fleetB, 'fleet-b', portB, registryDir);

    const first = new Supervisor(fleetA, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      env: {},
    });
    let second = new Supervisor(fleetB, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      env: {},
    });
    supervisors.push(first, second);
    await first.start();
    await second.start();

    const firstTools = await rpc<{
      tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    }>(portA, 'reviewer', 'tools/list');
    expect(firstTools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['list_peers', 'send_to_peer', 'get_peer_message_status']),
    );
    expect(firstTools.tools.find((tool) => tool.name === 'send_to_peer')?.inputSchema.properties).not.toHaveProperty(
      'sourceSession',
    );

    const directory = await callTool<{ peers: PeerDirectoryEntry[] }>(portA, 'reviewer', 'list_peers', {});
    expect(directory.peers).toEqual([
      expect.objectContaining({
        address: 'reviewer@fleet-b',
        presence: 'stopped',
        transport: 'local',
      }),
    ]);
    expect(directory.peers[0]?.instanceId).toEqual(expect.any(String));
    expect(await first.command('/help')).toContain(
      'Federation:\n  /peers — List explicitly exposed sessions in other local Conductor fleets.',
    );
    expect(await first.command('/peers')).toContain('reviewer@fleet-b — stopped · local');
    expect(first.statusReport()).toMatch(
      /Federation:\n {2}local · running · last contact: .* · queued: 0 · received: 0/u,
    );
    await expect(
      callToolError(portA, 'reviewer', 'send_to_peer', {
        address: 'hidden@fleet-b',
        message: 'should fail',
      }),
    ).resolves.toContain('[recipient_hidden]');
    await expect(
      callToolError(portA, 'reviewer', 'send_to_peer', {
        address: 'reviewer@missing-fleet',
        message: 'should fail',
      }),
    ).resolves.toContain('[unknown_fleet]');

    const outbound = await callTool<FederationMessageReceipt>(portA, 'reviewer', 'send_to_peer', {
      address: 'reviewer@fleet-b',
      message: 'hello from A',
      idempotencyKey: 'a-to-b',
    });
    expect(outbound).toMatchObject({
      recipient: 'reviewer@fleet-b',
      status: 'received',
      deduplicated: false,
    });
    expect(first.statusReport('reviewer')).toContain('"running": false');
    expect(second.statusReport('reviewer')).toContain('"running": false');

    const repeated = await callTool<FederationMessageReceipt>(portA, 'reviewer', 'send_to_peer', {
      address: 'reviewer@fleet-b',
      message: 'changed',
      idempotencyKey: 'a-to-b',
    });
    expect(repeated).toMatchObject({ messageId: outbound.messageId, deduplicated: true });

    const reply = await second.command('/tell-peer reviewer reviewer@fleet-a reply from B');
    expect(reply).toMatch(/^Received peer message [0-9a-f-]+ for reviewer@fleet-a\.$/u);
    expect(await first.command(`/peer-message-status ${outbound.messageId}`)).toContain('"status": "received"');

    await second.stop();
    supervisors.splice(supervisors.indexOf(second), 1);
    const whileOffline = await callTool<FederationMessageReceipt>(portA, 'reviewer', 'send_to_peer', {
      address: 'reviewer@fleet-b',
      message: 'survive peer restart',
      idempotencyKey: 'offline-a-to-b',
    });
    expect(whileOffline.status).toBe('queued');

    second = new Supervisor(fleetB, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      env: {},
    });
    supervisors.push(second);
    await second.start();
    await until(async () => {
      const status = await callTool<{ status: string }>(portA, 'reviewer', 'get_peer_message_status', {
        messageId: whileOffline.messageId,
      });
      return status.status === 'received';
    });
    expect(second.statusReport('reviewer')).toContain('"running": false');

    writeFleetConfig(fleetB, 'fleet-b', portB, registryDir, ['hidden'], 'Updated public fleet');
    second.reloadSessionsForTest();
    await expect(callTool<{ peers: PeerDirectoryEntry[] }>(portA, 'reviewer', 'list_peers', {})).resolves.toEqual({
      peers: [
        expect.objectContaining({
          address: 'hidden@fleet-b',
          fleetDescription: 'Updated public fleet',
          description: 'Public hidden',
        }),
      ],
    });

    await Promise.all([first.stop(), second.stop()]);
    supervisors.length = 0;
    const firstStore = new Store(join(fleetA, 'data', 'conductor.db'));
    const secondStore = new Store(join(fleetB, 'data', 'conductor.db'));
    expect(firstStore.getPendingMessages('reviewer')).toEqual([
      expect.objectContaining({ sender: 'reviewer@fleet-b', content: 'reply from B' }),
    ]);
    expect(secondStore.getPendingMessages('reviewer')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sender: 'reviewer@fleet-a', content: 'hello from A' }),
        expect.objectContaining({ sender: 'reviewer@fleet-a', content: 'survive peer restart' }),
      ]),
    );
    firstStore.close();
    secondStore.close();
  });

  it('keeps disabled federation out of MCP and rejects duplicate live fleet names', async () => {
    const registryDir = join(root, 'registry');
    const fleetA = join(root, 'fleet-a-dir');
    const fleetB = join(root, 'fleet-b-dir');
    const disabled = join(root, 'disabled');
    const portA = await freePort();
    const portB = await freePort();
    const disabledPort = await freePort();
    writeFleet(fleetA, 'same-name', portA, registryDir);
    writeFleet(fleetB, 'same-name', portB, registryDir);
    writeDisabledFleet(disabled, disabledPort);

    const first = new Supervisor(fleetA, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      env: {},
    });
    const second = new Supervisor(fleetB, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      env: {},
    });
    const third = new Supervisor(disabled, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      env: {},
    });
    supervisors.push(first, second, third);
    await first.start();
    await expect(second.start()).rejects.toThrow(/already used.*unique federation.name/);
    await third.start();

    const tools = await rpc<{ tools: { name: string }[] }>(disabledPort, 'reviewer', 'tools/list');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('send_to_peer');
  });

  it('quiesces federation ingress before slow channel shutdown and Store close', async () => {
    const registryDir = join(root, 'registry');
    const fleetA = join(root, 'fleet-a-dir');
    const fleetB = join(root, 'fleet-b-dir');
    const portA = await freePort();
    const portB = await freePort();
    writeFleet(fleetA, 'fleet-a', portA, registryDir);
    writeFleet(fleetB, 'fleet-b', portB, registryDir);
    const blockingChannel = new BlockingChannel();
    const first = new Supervisor(fleetA, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      channels: [blockingChannel],
      env: {},
    });
    const second = new Supervisor(fleetB, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      env: {},
    });
    supervisors.push(first, second);
    await first.start();
    await second.start();
    await second.command('/peers');

    const stopping = first.stop();
    await blockingChannel.stopStarted;
    const receipt = await callTool<FederationMessageReceipt>(portB, 'reviewer', 'send_to_peer', {
      address: 'reviewer@fleet-a',
      message: 'must not cross the shutdown boundary',
    });
    expect(receipt.status).toBe('queued');
    blockingChannel.releaseStop();
    await stopping;
    supervisors.splice(supervisors.indexOf(first), 1);

    const store = new Store(join(fleetA, 'data', 'conductor.db'));
    expect(store.getPendingMessages('reviewer')).toEqual([]);
    store.close();
  });
});

function writeFleet(baseDir: string, name: string, port: number, registryDir: string): void {
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  writeFleetConfig(baseDir, name, port, registryDir, ['reviewer']);
  writeFileSync(join(baseDir, 'config', 'sessions', 'reviewer.yaml'), `codename: reviewer\nrepo: ${baseDir}\n`);
  writeFileSync(join(baseDir, 'config', 'sessions', 'hidden.yaml'), `codename: hidden\nrepo: ${baseDir}\n`);
}

function writeFleetConfig(
  baseDir: string,
  name: string,
  port: number,
  registryDir: string,
  exposed: readonly string[],
  description?: string,
): void {
  writeFileSync(
    join(baseDir, 'config', 'supervisor.yaml'),
    [
      'terminal:',
      '  backend: tmux',
      'mcp:',
      `  port: ${String(port)}`,
      'federation:',
      `  name: ${name}`,
      ...(description === undefined ? [] : [`  description: ${description}`]),
      '  sessions:',
      `    expose: [${exposed.join(', ')}]`,
      '    descriptions:',
      ...exposed.map((codename) => `      ${codename}: Public ${codename}`),
      '  local:',
      '    enabled: true',
      `    registryDir: ${JSON.stringify(registryDir)}`,
      '    heartbeatSeconds: 1',
      '    staleAfterSeconds: 4',
    ].join('\n'),
  );
}

function writeDisabledFleet(baseDir: string, port: number): void {
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  writeFileSync(
    join(baseDir, 'config', 'supervisor.yaml'),
    `terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\n`,
  );
  writeFileSync(join(baseDir, 'config', 'sessions', 'reviewer.yaml'), `codename: reviewer\nrepo: ${baseDir}\n`);
}

async function callTool<T>(port: number, caller: string, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await rpc<{ structuredContent: T }>(port, caller, 'tools/call', {
    name,
    arguments: args,
  });
  return result.structuredContent;
}

async function callToolError(
  port: number,
  caller: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/mcp/${caller}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await response.json()) as { error?: { message?: string } };
  return body.error?.message ?? '';
}

async function rpc<T>(port: number, caller: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/mcp/${caller}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.result === undefined) throw new Error(`RPC failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('No TCP port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function until(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for federation state.');
}

class BlockingChannel implements ChannelAdapter {
  readonly name = 'blocking';
  private resolveStarted!: () => void;
  private resolveRelease!: () => void;
  readonly stopStarted = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly stopReleased = new Promise<void>((resolve) => {
    this.resolveRelease = resolve;
  });

  start(_handlers: ChannelHandlers): Promise<void> {
    return Promise.resolve();
  }

  send(_message: ChannelMessage): Promise<void> {
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.resolveStarted();
    await this.stopReleased;
  }

  releaseStop(): void {
    this.resolveRelease();
  }
}
