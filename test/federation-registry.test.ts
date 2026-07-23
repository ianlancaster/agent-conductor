import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFederationRegistry } from '../src/federation/registry.js';

let registryDir: string;
const registries: LocalFederationRegistry[] = [];
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'conductor-federation-registry-'));
});

afterEach(() => {
  for (const registry of registries.splice(0)) registry.stop();
  rmSync(registryDir, { recursive: true, force: true });
});

function registry(instanceId: string, fleet: string, pid: number): LocalFederationRegistry {
  const created = new LocalFederationRegistry({
    registryDir,
    instanceId,
    fleet,
    endpoint: `http://127.0.0.1:${String(4000 + pid)}/federation/v1`,
    heartbeatMs: 5_000,
    staleAfterMs: 20_000,
    now: () => 10_000,
    pid,
    pidAlive: () => true,
  });
  registries.push(created);
  return created;
}

describe('local federation registry', () => {
  it('writes owner-only atomic records and removes only its matching registration', () => {
    const first = registry(INSTANCE_A, 'fleet-a', 1);
    first.start();

    expect(statSync(registryDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(registryDir)).toEqual([`${INSTANCE_A}.json`]);
    const recordPath = join(registryDir, `${INSTANCE_A}.json`);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { credential: string };
    expect(record.credential.length).toBeGreaterThanOrEqual(40);
    expect(readdirSync(registryDir).some((entry) => entry.endsWith('.tmp'))).toBe(false);

    // A successor record with the same instance id must survive the old
    // process's clean-shutdown guard.
    writeFileSync(
      recordPath,
      JSON.stringify({
        ...first.ownRecord(),
        pid: 99,
        startedAt: 20_000,
        credential: 'different-credential-that-is-long-enough-for-validation',
      }),
      { mode: 0o600 },
    );
    first.stop();
    expect(readFileSync(recordPath, 'utf8')).toContain('different-credential');
  });

  it('rejects duplicate live friendly names without overwriting either instance', () => {
    const first = registry(INSTANCE_A, 'same-fleet', 1);
    const second = registry(INSTANCE_B, 'same-fleet', 2);
    first.start();
    expect(() => second.start()).toThrow(/already used.*Set a unique federation.name/);
    expect(readdirSync(registryDir)).toEqual([`${INSTANCE_A}.json`]);
  });

  it('rejects a second live process claiming the same stable instance identity', () => {
    const first = registry(INSTANCE_A, 'fleet-a', 1);
    const duplicate = registry(INSTANCE_A, 'fleet-copy', 2);
    first.start();
    expect(() => duplicate.start()).toThrow(/instance .* already live/u);
    const record = JSON.parse(readFileSync(join(registryDir, `${INSTANCE_A}.json`), 'utf8')) as {
      fleet: string;
      pid: number;
    };
    expect(record).toMatchObject({ fleet: 'fleet-a', pid: 1 });
  });

  it('prunes stale heartbeats even when the recorded pid still appears alive', () => {
    const active = registry(INSTANCE_A, 'fleet-a', 1);
    active.start();
    writeFileSync(
      join(registryDir, '33333333-3333-4333-8333-333333333333.json'),
      JSON.stringify({
        version: 1,
        instanceId: '33333333-3333-4333-8333-333333333333',
        fleet: 'fleet-stale',
        endpoint: 'http://127.0.0.1:4999/federation/v1',
        pid: 999,
        credential: 'stale-credential-that-is-at-least-forty-characters-long',
        startedAt: 1,
        heartbeatAt: -20_000,
      }),
      { mode: 0o600 },
    );
    expect(active.records().map((record) => record.instanceId)).toEqual([INSTANCE_A]);
    expect(readdirSync(registryDir)).toEqual([`${INSTANCE_A}.json`]);
  });

  it('contains heartbeat filesystem failures and recovers on a later tick', async () => {
    const live = new LocalFederationRegistry({
      registryDir,
      instanceId: INSTANCE_A,
      fleet: 'fleet-a',
      endpoint: 'http://127.0.0.1:4001/federation/v1',
      heartbeatMs: 10,
      staleAfterMs: 100,
      pid: 1,
      pidAlive: () => true,
    });
    registries.push(live);
    live.start();

    rmSync(registryDir, { recursive: true });
    writeFileSync(registryDir, 'temporarily not a directory');
    await until(() => live.health().lastErrorCode === 'registry_io');

    rmSync(registryDir);
    mkdirSync(registryDir, { mode: 0o700 });
    await until(() => live.health().lastErrorCode === null && readdirSync(registryDir).includes(`${INSTANCE_A}.json`));
  });

  it('does not reclaim a friendly name after its stale registration is replaced', async () => {
    let now = 1_000;
    const old = new LocalFederationRegistry({
      registryDir,
      instanceId: INSTANCE_A,
      fleet: 'same-fleet',
      endpoint: 'http://127.0.0.1:4001/federation/v1',
      heartbeatMs: 30,
      staleAfterMs: 40,
      now: () => now,
      pid: 1,
      pidAlive: () => true,
    });
    registries.push(old);
    old.start();
    now = 2_000;
    const replacement = new LocalFederationRegistry({
      registryDir,
      instanceId: INSTANCE_B,
      fleet: 'same-fleet',
      endpoint: 'http://127.0.0.1:4002/federation/v1',
      heartbeatMs: 30,
      staleAfterMs: 40,
      now: () => now,
      pid: 2,
      pidAlive: () => true,
    });
    registries.push(replacement);
    replacement.start();

    await until(() => old.health().lastErrorCode === 'instance_collision');
    expect(readdirSync(registryDir)).toEqual([`${INSTANCE_B}.json`]);
    expect(JSON.parse(readFileSync(join(registryDir, `${INSTANCE_B}.json`), 'utf8'))).toMatchObject({
      fleet: 'same-fleet',
      pid: 2,
    });
  });
});

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for registry state.');
}
