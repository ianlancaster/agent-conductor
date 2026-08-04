import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Supervisor } from '../src/core/supervisor.js';
import { FEDERATION_PROTOCOL_VERSION } from '../src/federation/registry.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

interface RpcResponse {
  result?: {
    content?: { type: string; text: string }[];
    structuredContent?: unknown;
    tools?: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
  };
  error?: { code: number; message: string };
}

let root: string;
let registryDir: string;
const supervisors: Supervisor[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conductor-federation-'));
  registryDir = join(root, 'registry');
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0).reverse()) await supervisor.stop();
  rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not allocate a test port.'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function writeFleet(baseDir: string, port: number, fleet: string, expose: string[], sessions: string[]): void {
  const configDir = join(baseDir, 'config');
  mkdirSync(join(configDir, 'sessions'), { recursive: true });
  writeFileSync(
    join(configDir, 'supervisor.yaml'),
    `mcp:\n  port: ${String(port)}\nfederation:\n  name: ${fleet}\n  expose:\n${expose.map((name) => `    - ${name}`).join('\n')}\n`,
  );
  for (const codename of sessions) {
    const repo = join(baseDir, codename);
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(configDir, 'sessions', `${codename}.yaml`),
      `codename: ${codename}\nrepo: ${repo}\nruntime: claude-code\n`,
    );
  }
}

async function rpc(
  port: number,
  caller: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<RpcResponse> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/mcp/${caller}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await response.json()) as RpcResponse;
}

async function call(port: number, caller: string, name: string, args: Record<string, unknown>): Promise<RpcResponse> {
  return rpc(port, caller, 'tools/call', { name, arguments: args });
}

async function federationPost(port: number, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/federation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('local Conductor federation', () => {
  it('discovers exposed rosters and routes canonical operations with qualified receipts and identity', async () => {
    const frontendDir = join(root, 'frontend');
    const backendDir = join(root, 'backend');
    const frontendPort = await freePort();
    const backendPort = await freePort();
    writeFleet(frontendDir, frontendPort, 'frontend', ['alpha'], ['alpha', 'local']);
    writeFleet(backendDir, backendPort, 'backend', ['beta'], ['beta', 'secret']);

    const frontendTerminal = new FakeTerminalBackend();
    const backendTerminal = new FakeTerminalBackend();
    const backendRuntime = new FakeRuntime('claude-code');
    const frontend = new Supervisor(frontendDir, {
      terminalBackend: frontendTerminal,
      runtimes: [new FakeRuntime('claude-code')],
      includeConfiguredChannels: false,
      federationDirectory: registryDir,
      env: {},
    });
    const backend = new Supervisor(backendDir, {
      terminalBackend: backendTerminal,
      runtimes: [backendRuntime],
      includeConfiguredChannels: false,
      federationDirectory: registryDir,
      env: {},
    });
    supervisors.push(frontend, backend);
    await frontend.start();
    await backend.start();

    const discovery = await call(frontendPort, 'alpha', 'list_federation', {});
    expect(discovery.result?.structuredContent).toEqual({
      localFleet: 'frontend',
      fleets: [
        { name: 'backend', sessions: ['beta'] },
        { name: 'frontend', sessions: ['alpha'] },
      ],
    });

    const ownFleet = await call(frontendPort, 'alpha', 'send_to_session', {
      fleet: 'frontend',
      codename: 'local',
      message: 'explicitly local',
    });
    expect(ownFleet.result?.structuredContent).toMatchObject({ recipient: 'local', status: 'delivered' });
    expect(ownFleet.result?.structuredContent).not.toHaveProperty('fleet');

    const omittedFleet = await call(frontendPort, 'alpha', 'send_to_session', {
      codename: 'local',
      message: 'implicitly local',
    });
    expect(omittedFleet.result?.structuredContent).toMatchObject({ recipient: 'local', status: 'delivered' });
    expect(omittedFleet.result?.structuredContent).not.toHaveProperty('fleet');

    const sent = await call(frontendPort, 'alpha', 'send_to_session', {
      fleet: 'backend',
      codename: 'beta',
      message: 'hello from the frontend',
      idempotencyKey: 'cross-fleet-1',
    });
    expect(sent.error).toBeUndefined();
    expect(sent.result?.structuredContent, JSON.stringify(sent)).toMatchObject({
      messageId: 1,
      recipient: 'beta',
      fleet: 'backend',
      status: 'delivered',
      deduplicated: false,
    });

    const backendStore = new Store(join(backendDir, 'data', 'conductor.db'));
    expect(backendStore.getMessage(1)).toMatchObject({ sender: 'alpha@frontend', recipient: 'beta' });
    backendStore.close();

    const receipt = await call(frontendPort, 'alpha', 'get_message_status', {
      fleet: 'backend',
      messageId: 1,
    });
    expect(receipt.result?.content?.[0]?.text).toContain('"sender":"alpha@frontend"');

    const replay = await call(frontendPort, 'alpha', 'send_to_session', {
      fleet: 'backend',
      codename: 'beta',
      message: 'hello from the frontend',
      idempotencyKey: 'cross-fleet-1',
    });
    expect(replay.result?.structuredContent).toMatchObject({ messageId: 1, fleet: 'backend', deduplicated: true });

    const sameKeyDifferentSender = await call(frontendPort, 'local', 'send_to_session', {
      fleet: 'backend',
      codename: 'beta',
      message: 'same key from a different qualified sender',
      idempotencyKey: 'cross-fleet-1',
    });
    expect(sameKeyDifferentSender.result?.structuredContent).toMatchObject({
      messageId: 2,
      fleet: 'backend',
      deduplicated: false,
    });

    const listing = await call(frontendPort, 'alpha', 'list_sessions', { fleet: 'backend' });
    const listingText = listing.result?.content?.[0]?.text ?? '';
    expect(listingText).toContain('beta');
    expect(listingText).not.toContain('secret');
    expect(listingText).not.toContain('Federation:');
    expect(listingText).not.toContain('Integrations:');

    const hiddenCalls: [string, Record<string, unknown>][] = [
      ['start_session', { codename: 'secret' }],
      ['stop_session', { codename: 'secret' }],
      ['continue_session', { codename: 'secret' }],
      ['toggle_auto', { codename: 'secret' }],
      ['pause_session', { codename: 'secret' }],
      ['resume_session', { codename: 'secret' }],
      ['set_tag', { codename: 'secret', tag: 'leaked' }],
      ['get_session_status', { codename: 'secret' }],
      ['tail_session', { codename: 'secret' }],
      ['send_to_session', { codename: 'secret', message: 'should not arrive' }],
    ];
    for (const [operation, args] of hiddenCalls) {
      const hidden = await call(frontendPort, 'alpha', operation, { fleet: 'backend', ...args });
      expect(hidden.result?.content?.[0]?.text, operation).toBe('Unknown session: secret');
    }
    const secretAfterDirectCalls = await call(backendPort, 'beta', 'get_session_status', { codename: 'secret' });
    expect(secretAfterDirectCalls.result?.content?.[0]?.text).toContain('"running": false');
    expect(secretAfterDirectCalls.result?.content?.[0]?.text).toContain('"auto": false');
    expect(secretAfterDirectCalls.result?.content?.[0]?.text).toContain('"paused": false');
    expect(secretAfterDirectCalls.result?.content?.[0]?.text).toContain('"tag": null');

    await call(frontendPort, 'alpha', 'stop_session', { fleet: 'backend', codename: 'all' });
    await call(frontendPort, 'alpha', 'start_session', { fleet: 'backend', codename: 'all' });
    let betaStatus = await call(backendPort, 'secret', 'get_session_status', { codename: 'beta' });
    let secretStatus = await call(backendPort, 'beta', 'get_session_status', { codename: 'secret' });
    expect(betaStatus.result?.content?.[0]?.text).toContain('"running": true');
    expect(secretStatus.result?.content?.[0]?.text).toContain('"running": false');

    await call(frontendPort, 'alpha', 'stop_session', { fleet: 'backend', codename: 'all' });
    await call(frontendPort, 'alpha', 'continue_session', { fleet: 'backend', codename: 'all' });
    betaStatus = await call(backendPort, 'secret', 'get_session_status', { codename: 'beta' });
    secretStatus = await call(backendPort, 'beta', 'get_session_status', { codename: 'secret' });
    expect(betaStatus.result?.content?.[0]?.text).toContain('"running": true');
    expect(secretStatus.result?.content?.[0]?.text).toContain('"running": false');

    await call(frontendPort, 'alpha', 'pause_session', { fleet: 'backend', codename: 'all' });
    betaStatus = await call(backendPort, 'secret', 'get_session_status', { codename: 'beta' });
    secretStatus = await call(backendPort, 'beta', 'get_session_status', { codename: 'secret' });
    expect(betaStatus.result?.content?.[0]?.text).toContain('"paused": true');
    expect(secretStatus.result?.content?.[0]?.text).toContain('"paused": false');

    await call(frontendPort, 'alpha', 'resume_session', { fleet: 'backend', codename: 'all' });
    await call(frontendPort, 'alpha', 'toggle_auto', { fleet: 'backend', codename: 'all' });
    betaStatus = await call(backendPort, 'secret', 'get_session_status', { codename: 'beta' });
    secretStatus = await call(backendPort, 'beta', 'get_session_status', { codename: 'secret' });
    expect(betaStatus.result?.content?.[0]?.text).toContain('"paused": false');
    expect(betaStatus.result?.content?.[0]?.text).toContain('"auto": true');
    expect(secretStatus.result?.content?.[0]?.text).toContain('"paused": false');
    expect(secretStatus.result?.content?.[0]?.text).toContain('"auto": false');

    await call(backendPort, 'beta', 'start_session', { codename: 'secret' });
    const secretReceivedBefore = backendTerminal.paneFor('secret')?.received.length ?? 0;
    await call(frontendPort, 'alpha', 'broadcast', { fleet: 'backend', message: 'visible agents only' });
    expect(backendTerminal.paneFor('beta')?.received.join('\n')).toContain('visible agents only');
    expect(backendTerminal.paneFor('secret')?.received).toHaveLength(secretReceivedBefore);

    backendRuntime.inputState = 'draft';
    const queued = await call(frontendPort, 'alpha', 'send_to_session', {
      fleet: 'backend',
      codename: 'beta',
      message: 'cancel this queued remote message',
    });
    expect(queued.result?.structuredContent).toMatchObject({ fleet: 'backend', status: 'queued' });
    const queuedMessageId = (queued.result?.structuredContent as { messageId: number }).messageId;
    const unauthorizedCancel = await call(frontendPort, 'local', 'cancel_message', {
      fleet: 'backend',
      messageId: queuedMessageId,
    });
    expect(unauthorizedCancel.result?.content?.[0]?.text).toBe(`Message #${String(queuedMessageId)} was not found.`);
    const cancelled = await call(frontendPort, 'alpha', 'cancel_message', {
      fleet: 'backend',
      messageId: queuedMessageId,
    });
    expect(cancelled.result?.content?.[0]?.text).toBe(`Message #${String(queuedMessageId)} cancelled.`);
    const cancelledStatus = await call(frontendPort, 'alpha', 'get_message_status', {
      fleet: 'backend',
      messageId: queuedMessageId,
    });
    expect(cancelledStatus.result?.content?.[0]?.text).toContain('"status":"cancelled"');

    const baseRequest = {
      protocol: FEDERATION_PROTOCOL_VERSION,
      operation: 'list_sessions',
      arguments: {},
      originFleet: 'frontend',
      originSession: 'alpha',
    };
    await expect(federationPost(backendPort, { ...baseRequest, protocol: 999 })).resolves.toMatchObject({
      status: 400,
      body: { ok: false, invalid: true },
    });
    await expect(federationPost(backendPort, { ...baseRequest, originSession: 'alpha@forged' })).resolves.toMatchObject(
      { status: 400, body: { ok: false, invalid: true, error: 'Invalid federation origin session.' } },
    );
    await expect(federationPost(backendPort, { ...baseRequest, originFleet: 'backend' })).resolves.toMatchObject({
      status: 400,
      body: { ok: false, invalid: true },
    });
    await expect(federationPost(backendPort, { ...baseRequest, originFleet: 'missing' })).resolves.toMatchObject({
      status: 400,
      body: { ok: false, invalid: true },
    });
    for (const operation of [
      'get_conductor_docs',
      'list_federation',
      'send_to_operator',
      'set_sentinel',
      'spawn_session',
      'teardown_session',
      'toggle_fleet_watch',
      'type_in_pane',
      'whoami',
    ]) {
      await expect(federationPost(backendPort, { ...baseRequest, operation })).resolves.toMatchObject({
        status: 400,
        body: { ok: false, invalid: true },
      });
    }

    const ordinary = await fetch(`http://127.0.0.1:${String(frontendPort)}/mcp/alpha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
        originFleet: 'backend',
        originSession: 'forged',
      }),
    });
    const ordinaryPayload = (await ordinary.json()) as RpcResponse;
    expect(ordinaryPayload.result?.content?.[0]?.text).toContain('"codename": "alpha"');
  });

  it('decorates only routable tools and rejects unknown fleets without local fallback', async () => {
    const baseDir = join(root, 'solo');
    const port = await freePort();
    writeFleet(baseDir, port, 'solo', ['alpha'], ['alpha']);
    const supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      runtimes: [new FakeRuntime('claude-code')],
      includeConfiguredChannels: false,
      federationDirectory: registryDir,
      env: {},
    });
    supervisors.push(supervisor);
    await supervisor.start();

    const listed = await rpc(port, 'alpha', 'tools/list');
    const tools = new Map((listed.result?.tools ?? []).map((tool) => [tool.name, tool]));
    expect(tools.get('send_to_session')?.inputSchema.properties).toHaveProperty('fleet');
    expect(tools.get('list_sessions')?.inputSchema.properties).toHaveProperty('fleet');
    expect(tools.get('whoami')?.inputSchema.properties).not.toHaveProperty('fleet');
    expect(tools.get('send_to_operator')?.inputSchema.properties).not.toHaveProperty('fleet');
    expect(tools.get('type_in_pane')?.inputSchema.properties).not.toHaveProperty('fleet');
    expect(tools.get('list_federation')?.inputSchema.properties).not.toHaveProperty('fleet');

    const unknown = await call(port, 'alpha', 'stop_session', { fleet: 'missing', codename: 'alpha' });
    expect(unknown.error).toEqual({ code: -32602, message: 'Unknown or unavailable federation fleet: missing' });
    expect(supervisor.statusReport('alpha')).toContain('"running": false');

    const localOnly = await call(port, 'alpha', 'whoami', { fleet: 'solo' });
    expect(localOnly.error?.message).toContain("Unknown argument 'fleet'");

    const qualifiedTarget = await call(port, 'alpha', 'send_to_session', {
      codename: 'beta@backend',
      message: 'wrong shape',
    });
    expect(qualifiedTarget.error?.message).toContain("pass the local codename and the separate 'fleet' argument");
  });

  it('starts tolerantly when an exposed session configuration is temporarily malformed', async () => {
    const baseDir = join(root, 'malformed-exposure');
    const port = await freePort();
    writeFleet(baseDir, port, 'tolerant', ['alpha'], ['alpha']);
    writeFileSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'), 'codename: [\n');

    const supervisor = new Supervisor(baseDir, {
      terminalBackend: new FakeTerminalBackend(),
      runtimes: [new FakeRuntime('claude-code')],
      includeConfiguredChannels: false,
      federationDirectory: registryDir,
      env: {},
    });
    supervisors.push(supervisor);
    await supervisor.start();

    const discovery = await call(port, 'observer', 'list_federation', {});
    expect(discovery.result?.structuredContent).toEqual({
      localFleet: 'tolerant',
      fleets: [{ name: 'tolerant', sessions: [] }],
    });
  });
});
