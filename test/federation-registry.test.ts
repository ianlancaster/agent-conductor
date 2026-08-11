import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FEDERATION_PROTOCOL_VERSION,
  FederationRegistry,
  type FederationPeerRecord,
} from '../src/federation/registry.js';

let root: string;
let registryDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conductor-federation-registry-'));
  registryDir = join(root, 'registry');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function registry(
  name: string,
  sessions: string[] = ['beta'],
  rooms: FederationPeerRecord['rooms'] = [],
): FederationRegistry {
  return new FederationRegistry({
    name,
    host: '127.0.0.1',
    port: 3456,
    sessions: () => sessions,
    rooms: () => rooms,
    directory: registryDir,
  });
}

function record(overrides: Partial<FederationPeerRecord> = {}): FederationPeerRecord {
  return {
    name: 'backend',
    host: '127.0.0.1',
    port: 3457,
    pid: process.pid,
    protocol: FEDERATION_PROTOCOL_VERSION,
    sessions: ['reviewer'],
    rooms: [],
    ...overrides,
  };
}

describe('FederationRegistry', () => {
  it('claims one name exclusively and removes only its own record', async () => {
    const first = registry('frontend');
    const second = registry('frontend');
    await first.claim();

    const published = JSON.parse(readFileSync(join(registryDir, 'frontend.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(published).sort()).toEqual(['host', 'name', 'pid', 'port', 'protocol', 'rooms', 'sessions']);
    expect(JSON.stringify(published)).not.toContain(root);

    await expect(second.claim()).rejects.toThrow(/already registered by live process/);
    expect(await first.list()).toEqual([
      {
        name: 'frontend',
        host: '127.0.0.1',
        port: 3456,
        pid: process.pid,
        protocol: FEDERATION_PROTOCOL_VERSION,
        sessions: ['beta'],
        rooms: [],
      },
    ]);

    await second.release();
    expect(existsSync(join(registryDir, 'frontend.json'))).toBe(true);
    await first.release();
    expect(existsSync(join(registryDir, 'frontend.json'))).toBe(false);
  });

  it('reclaims dead records and prunes malformed records without network probes', async () => {
    const active = registry('frontend');
    await active.claim();
    writeFileSync(join(registryDir, 'backend.json'), `${JSON.stringify(record({ pid: 999_999 }))}\n`);
    writeFileSync(join(registryDir, 'broken.json'), '{');

    expect((await active.list()).map((peer) => peer.name)).toEqual(['frontend']);
    expect(existsSync(join(registryDir, 'backend.json'))).toBe(false);
    expect(existsSync(join(registryDir, 'broken.json'))).toBe(false);
    await active.release();
  });

  it('publishes room membership and stays compatible with a peer that predates rooms', async () => {
    const active = registry('frontend', ['alpha'], [{ name: 'design-review', members: ['beta', 'alpha', 'alpha'] }]);
    await active.claim();
    // A record written before the rooms feature has no `rooms` field at all; it
    // must still parse and simply contribute no members.
    const { rooms: _omitted, ...legacy } = record();
    writeFileSync(join(registryDir, 'backend.json'), `${JSON.stringify(legacy)}\n`);

    const peers = await active.list();
    expect(peers.find((peer) => peer.name === 'frontend')?.rooms).toEqual([
      { name: 'design-review', members: ['alpha', 'beta'] },
    ]);
    expect(peers.find((peer) => peer.name === 'backend')?.rooms).toEqual([]);
    await active.release();
  });

  it('rejects a record whose room membership is malformed', async () => {
    const active = registry('frontend');
    await active.claim();
    writeFileSync(
      join(registryDir, 'backend.json'),
      `${JSON.stringify(record({ rooms: [{ name: 'Design Review', members: ['beta'] }] }))}\n`,
    );

    expect((await active.list()).map((peer) => peer.name)).toEqual(['frontend']);
    expect(existsSync(join(registryDir, 'backend.json'))).toBe(false);
    await active.release();
  });

  it('rejects records whose claimed name does not match their filename', async () => {
    const active = registry('frontend');
    await active.claim();
    writeFileSync(join(registryDir, 'impostor.json'), `${JSON.stringify(record({ name: 'backend' }))}\n`);

    expect((await active.list()).map((peer) => peer.name)).toEqual(['frontend']);
    expect(existsSync(join(registryDir, 'impostor.json'))).toBe(false);
    await active.release();
  });

  it('filters incompatible protocols and atomically republishes a sorted roster', async () => {
    const sessions = ['zeta', 'alpha', 'alpha'];
    const active = registry('frontend', sessions);
    await active.claim();
    writeFileSync(
      join(registryDir, 'backend.json'),
      `${JSON.stringify(record({ protocol: FEDERATION_PROTOCOL_VERSION + 1 }))}\n`,
    );

    expect((await active.list()).map((peer) => peer.name)).toEqual(['frontend']);
    sessions.splice(0, sessions.length, 'gamma');
    await active.update();
    expect(JSON.parse(readFileSync(join(registryDir, 'frontend.json'), 'utf8'))).toMatchObject({
      sessions: ['gamma'],
    });
    await active.release();
  });

  it('uses XDG when writable and a stable home fallback otherwise', async () => {
    const xdg = join(root, 'xdg');
    const home = join(root, 'home');
    const xdgRegistry = new FederationRegistry({
      name: 'xdg-fleet',
      host: '127.0.0.1',
      port: 3456,
      sessions: () => [],
      env: { XDG_RUNTIME_DIR: xdg },
      homeDirectory: home,
    });
    await xdgRegistry.claim();
    expect(existsSync(join(xdg, 'agent-conductor', 'federation', 'xdg-fleet.json'))).toBe(true);
    await xdgRegistry.release();

    const unusable = join(root, 'not-a-directory');
    writeFileSync(unusable, 'occupied');
    const homeRegistry = new FederationRegistry({
      name: 'home-fleet',
      host: '127.0.0.1',
      port: 3456,
      sessions: () => [],
      env: { XDG_RUNTIME_DIR: unusable },
      homeDirectory: home,
    });
    await homeRegistry.claim();
    expect(existsSync(join(home, '.agent-conductor', 'federation', 'home-fleet.json'))).toBe(true);
    await homeRegistry.release();
  });

  it('rejects unsafe fleet names before using them as paths', () => {
    expect(() => registry('../escape')).toThrow(/Invalid federation name/);
    expect(() => registry('UPPER')).toThrow(/Invalid federation name/);
  });
});
