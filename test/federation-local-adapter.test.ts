import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFederationAdapter } from '../src/federation/local.js';
import type { LocalRegistryRecord } from '../src/federation/registry.js';
import type {
  FederatedWireMessage,
  FederationPeerRoute,
  FederationHopReceipt,
  PeerDirectoryEntry,
} from '../src/federation/types.js';

let registryDir: string;
const adapters: LocalFederationAdapter[] = [];
const servers: Server[] = [];
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';
const INSTANCE_C = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'conductor-federation-local-'));
});

afterEach(async () => {
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.stop()));
  await Promise.allSettled(servers.splice(0).map(closeServer));
  rmSync(registryDir, { recursive: true, force: true });
});

describe('LocalFederationAdapter', () => {
  it('binds loopback, rejects unauthenticated requests, and refreshes endpoint/credentials after peer restart', async () => {
    const accepted = new Map<string, number>();
    const first = makeAdapter(INSTANCE_A, 'fleet-a', 'alpha', accepted);
    let second = makeAdapter(INSTANCE_B, 'fleet-b', 'beta', accepted);
    adapters.push(first, second);
    await first.start();
    await second.start();

    const record = JSON.parse(readFileSync(join(registryDir, `${INSTANCE_A}.json`), 'utf8')) as LocalRegistryRecord;
    expect(record.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/federation\/v1$/u);
    const unauthenticated = await fetch(`${record.endpoint}/directory`);
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: { code: 'auth_invalid', retryable: true },
    });

    const staleRoute = (await first.directory())[0];
    expect(staleRoute).toMatchObject({ address: 'beta@fleet-b', instanceId: INSTANCE_B });
    const oldRecord = JSON.parse(readFileSync(join(registryDir, `${INSTANCE_B}.json`), 'utf8')) as LocalRegistryRecord;
    const malformed = await fetch(`${record.endpoint}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oldRecord.credential}` },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: 'message_invalid' } });
    const oversized = await fetch(`${record.endpoint}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oldRecord.credential}` },
      body: 'x'.repeat(71 * 1024),
    });
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: 'message_invalid' } });

    await second.stop();
    adapters.splice(adapters.indexOf(second), 1);
    second = makeAdapter(INSTANCE_B, 'fleet-b', 'beta', accepted);
    adapters.push(second);
    await second.start();
    const replacement = JSON.parse(
      readFileSync(join(registryDir, `${INSTANCE_B}.json`), 'utf8'),
    ) as LocalRegistryRecord;
    expect(replacement.credential).not.toBe(oldRecord.credential);

    const receipt = await first.send(staleRoute!, wire());
    expect(receipt).toMatchObject({ status: 'received', deduplicated: false });
    const repeated = await first.send(staleRoute!, wire());
    expect(repeated).toMatchObject({ status: 'received', deduplicated: true });
    expect(accepted.get(wire().messageId)).toBe(2);

    // The replacement's new credential authenticates immediately against A's
    // fresh registry read; no cached credential miss strands discovery.
    await expect(second.directory()).resolves.toEqual([
      expect.objectContaining({ address: 'alpha@fleet-a', instanceId: INSTANCE_A }),
    ]);
  });

  it('projects directory fields, reports refresh failures, and rejects malformed receipts/status values', async () => {
    let directoryCalls = 0;
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url?.endsWith('/directory') === true) {
        directoryCalls += 1;
        response.end(
          JSON.stringify(
            directoryCalls === 1
              ? {
                  ok: true,
                  version: 1,
                  entries: [
                    {
                      instanceId: INSTANCE_C,
                      fleet: 'fleet-c',
                      fleetDescription: 'must come from registry',
                      codename: 'gamma',
                      address: 'gamma@fleet-c',
                      description: 'Public gamma',
                      presence: 'running',
                      capabilities: ['messages'],
                      transport: 'local',
                      path: '/private/repo',
                      tag: 'secret-work',
                      nested: { arbitrary: true },
                    },
                  ],
                }
              : { ok: true, version: 1, entries: [{ address: 'forged' }] },
          ),
        );
      } else if (request.method === 'POST') {
        response.end(
          JSON.stringify({
            ok: true,
            version: 1,
            receipt: { messageId: INSTANCE_C, status: 'received', deduplicated: false },
          }),
        );
      } else {
        response.end(JSON.stringify({ ok: true, version: 1, status: 'invented' }));
      }
    });
    servers.push(server);
    const endpoint = await listen(server);
    const first = makeAdapter(INSTANCE_A, 'fleet-a', 'alpha', new Map());
    adapters.push(first);
    await first.start();
    writeFileSync(
      join(registryDir, `${INSTANCE_C}.json`),
      JSON.stringify({
        version: 1,
        instanceId: INSTANCE_C,
        fleet: 'fleet-c',
        endpoint: `${endpoint}/federation/v1`,
        pid: process.pid,
        credential: 'malformed-peer-credential-that-is-long-enough-for-validation',
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    const route: FederationPeerRoute = {
      instanceId: INSTANCE_C,
      fleet: 'fleet-c',
      codename: 'gamma',
      address: 'gamma@fleet-c',
      presence: 'running' as const,
      capabilities: ['messages'],
      transport: 'local',
    };

    await expect(first.directory()).resolves.toEqual([
      {
        instanceId: INSTANCE_C,
        fleet: 'fleet-c',
        codename: 'gamma',
        address: 'gamma@fleet-c',
        description: 'Public gamma',
        presence: 'running',
        capabilities: ['messages'],
        transport: 'local',
      },
    ]);
    await expect(first.directory()).resolves.toEqual([]);
    expect(first.health()).toMatchObject({ lastErrorCode: 'address_invalid' });
    await expect(first.send(route, wire())).rejects.toMatchObject({ code: 'message_invalid' });
    await expect(first.status(route, wire().messageId, 'alpha')).rejects.toMatchObject({ code: 'message_invalid' });
  });

  it('classifies ordinary destination failures as transient and accepts the same UUID after recovery', async () => {
    let unavailable = true;
    let accepted = 0;
    const first = makeAdapter(INSTANCE_A, 'fleet-a', 'alpha', new Map());
    const second = makeAdapter(INSTANCE_B, 'fleet-b', 'beta', new Map(), () => {
      if (unavailable) throw new Error('temporary sqlite failure');
      accepted += 1;
      return Promise.resolve({ messageId: wire().messageId, status: 'received', deduplicated: false });
    });
    adapters.push(first, second);
    await first.start();
    await second.start();
    const route = (await first.directory())[0]!;

    await expect(first.send(route, wire())).rejects.toMatchObject({
      code: 'internal_error',
      retryable: true,
    });
    unavailable = false;
    await expect(first.send(route, wire())).resolves.toMatchObject({
      messageId: wire().messageId,
      status: 'received',
    });
    expect(accepted).toBe(1);
  });

  it('waits for authenticated in-flight handlers while quiescing ingress', async () => {
    let signalStarted!: () => void;
    let releaseAccept!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseAccept = resolve;
    });
    const first = makeAdapter(INSTANCE_A, 'fleet-a', 'alpha', new Map());
    const second = makeAdapter(INSTANCE_B, 'fleet-b', 'beta', new Map(), async () => {
      signalStarted();
      await released;
      return { messageId: wire().messageId, status: 'received', deduplicated: false };
    });
    adapters.push(first, second);
    await first.start();
    await second.start();
    const route = (await first.directory())[0]!;

    const sending = first.send(route, wire());
    await started;
    let stopped = false;
    const stopping = second.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseAccept();
    await stopping;
    await expect(sending).rejects.toMatchObject({ code: 'peer_unavailable', retryable: true });
  });

  it('accepts a maximum-size legal directory above the message-response limit', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => {
      const prefix = `peer-${String(index)}-`;
      const codename = `${prefix}${'x'.repeat(120 - prefix.length)}`;
      return {
        instanceId: INSTANCE_C,
        fleet: 'fleet-c',
        codename,
        address: `${codename}@fleet-c`,
        description: '界'.repeat(200),
        presence: 'stopped',
        capabilities: ['messages'],
        transport: 'local',
      };
    });
    const payload = JSON.stringify({ ok: true, version: 1, entries });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(70 * 1024);
    expect(Buffer.byteLength(payload)).toBeLessThan(256 * 1024);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(payload);
    });
    servers.push(server);
    const endpoint = await listen(server);
    const first = makeAdapter(INSTANCE_A, 'fleet-a', 'alpha', new Map());
    adapters.push(first);
    await first.start();
    writeFileSync(
      join(registryDir, `${INSTANCE_C}.json`),
      JSON.stringify({
        version: 1,
        instanceId: INSTANCE_C,
        fleet: 'fleet-c',
        endpoint: `${endpoint}/federation/v1`,
        pid: process.pid,
        credential: 'large-peer-credential-that-is-long-enough-for-validation',
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
      { mode: 0o600 },
    );

    await expect(first.directory()).resolves.toHaveLength(100);
  });
});

function makeAdapter(
  instanceId: string,
  fleet: string,
  codename: string,
  accepted: Map<string, number>,
  acceptOverride?: (message: FederatedWireMessage) => Promise<FederationHopReceipt>,
): LocalFederationAdapter {
  const directory: PeerDirectoryEntry[] = [
    {
      instanceId,
      fleet,
      codename,
      address: `${codename}@${fleet}`,
      presence: 'stopped',
      capabilities: ['messages'],
      transport: 'local',
    },
  ];
  return new LocalFederationAdapter({
    registryDir,
    instanceId,
    fleet,
    heartbeatMs: 60_000,
    staleAfterMs: 120_000,
    exposedDirectory: () => directory,
    accept: (_source, message): Promise<FederationHopReceipt> => {
      if (acceptOverride !== undefined) return acceptOverride(message);
      const count = accepted.get(message.messageId) ?? 0;
      accepted.set(message.messageId, count + 1);
      return Promise.resolve({
        messageId: message.messageId,
        status: 'received',
        deduplicated: count > 0,
      });
    },
    status: () => Promise.resolve('received'),
  });
}

function wire(): FederatedWireMessage {
  return {
    version: 1,
    messageId: '11111111-1111-4111-8111-111111111111',
    sourceSession: 'alpha',
    destinationSession: 'beta',
    message: 'hello',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('No TCP port'));
        return;
      }
      resolve(`http://127.0.0.1:${String(address.port)}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
