import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionClaimAdmission } from '../src/config/admission.js';
import { loadSessionConfigs } from '../src/config/loader.js';

let root: string;
let fleets: string;
let claims: string;

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function gate(owner = 'fleet-one'): SessionClaimAdmission {
  return new SessionClaimAdmission({ enabled: true, claimDirectory: claims, owner }, fleets, 'fleet-one-id');
}

function writeClaim(
  claimId: string,
  codename: string,
  configPath: string,
  overrides: Record<string, unknown> = {},
): string {
  const owner = typeof overrides.owner === 'string' ? overrides.owner : 'fleet-one';
  const claim = Object.fromEntries(
    Object.entries({
      schemaVersion: 1,
      kind: 'conductor_session_admission_claim',
      claimId,
      status: 'leased',
      fleetId: 'fleet-one-id',
      conductorInstance: 'default',
      owner,
      ownerSha256: sha256(owner),
      resourceKind: 'exclusive',
      resourceNamespace: 'dev-port-block',
      resourceKey: 'instance-1',
      codename,
      configPath,
      leaseTokenSha256: sha256('lease-token'),
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  );
  const file = join(claims, `${claimId}.json`);
  writeFileSync(file, `${canonicalize(claim)}\n`, { mode: 0o444 });
  chmodSync(file, 0o444);
  return file;
}

function writeSession(codename: string, claimId: string, filename = codename): string {
  const file = join(fleets, 'config', 'sessions', `${filename}.yaml`);
  writeFileSync(
    file,
    `codename: ${codename}\nrepo: /tmp/${codename}\nadmissionClaim: ${claimId}\nadmissionResource:\n  kind: exclusive\n  namespace: dev-port-block\n  key: instance-1\n`,
  );
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conductor-admission-'));
  fleets = join(root, 'fleet-one');
  claims = join(root, 'claims');
  mkdirSync(join(fleets, 'config', 'sessions'), { recursive: true });
  mkdirSync(claims);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('session claim admission', () => {
  it('admits a leased claim only for its exact owner, codename, YAML path, and resource identity', () => {
    const config = writeSession('worker-1', 'claim-one');
    writeClaim('claim-one', 'worker-1', config);

    expect([...loadSessionConfigs(fleets, { admission: gate() }).keys()]).toEqual(['worker-1']);
    expect(() => loadSessionConfigs(fleets, { admission: gate('fleet-two') })).toThrow(/another owner/);

    writeFileSync(
      config,
      'codename: worker-1\nrepo: /tmp/worker-1\nadmissionClaim: claim-one\nadmissionResource:\n  kind: exclusive\n  namespace: dev-port-block\n  key: instance-2\n',
    );
    expect(() => loadSessionConfigs(fleets, { admission: gate() })).toThrow(/resource identity/);
  });

  it('makes an unmanaged config inert even when it appears after an empty claim-directory census', () => {
    writeSession('late-1', 'late-claim');
    expect(loadSessionConfigs(fleets, { admission: gate(), tolerant: true }).has('late-1')).toBe(false);

    const config = join(fleets, 'config', 'sessions', 'late-1.yaml');
    writeClaim('late-claim', 'late-1', config);
    expect(loadSessionConfigs(fleets, { admission: gate(), tolerant: true }).has('late-1')).toBe(true);
  });

  it('rejects filename drift, claim symlinks, mutable claims, noncanonical or duplicate-key JSON, and unknown fields', () => {
    const mismatched = writeSession('worker-1', 'claim-one', 'wrong-name');
    writeClaim('claim-one', 'worker-1', mismatched);
    expect(() => loadSessionConfigs(fleets, { admission: gate() })).toThrow(/filename/);
    rmSync(mismatched);
    chmodSync(join(claims, 'claim-one.json'), 0o644);
    rmSync(join(claims, 'claim-one.json'));

    const config = writeSession('worker-1', 'claim-one');
    const claim = writeClaim('claim-one', 'worker-1', config);
    chmodSync(claim, 0o644);
    expect(() => loadSessionConfigs(fleets, { admission: gate() })).toThrow(/mutable/);
    chmodSync(claim, 0o444);

    const real = join(root, 'real-claim.json');
    writeFileSync(real, readFileSync(claim));
    rmSync(claim);
    symlinkSync(real, claim);
    expect(() => loadSessionConfigs(fleets, { admission: gate() })).toThrow(/regular file/);
    rmSync(claim);

    writeFileSync(claim, `${readFileSync(real, 'utf8').trim()}  \n`, { mode: 0o444 });
    chmodSync(claim, 0o444);
    expect(() => loadSessionConfigs(fleets, { admission: gate() })).toThrow(/canonical JSON/);

    chmodSync(claim, 0o644);
    rmSync(claim);
    writeFileSync(claim, '{"claimId":"claim-one","claimId":"claim-one"}\n', { mode: 0o444 });
    chmodSync(claim, 0o444);
    expect(() => loadSessionConfigs(fleets, { admission: gate() })).toThrow(/invalid claim|canonical JSON/);

    chmodSync(claim, 0o644);
    rmSync(claim);
    writeClaim('claim-one', 'worker-1', config, { unknown: true });
    expect(() => loadSessionConfigs(fleets, { admission: gate() })).toThrow(/Unrecognized|unknown/);
  });

  it('admits an explicit immutable legacy reservation and never synthesizes one', () => {
    const config = writeSession('legacy-1', 'legacy-claim');
    const configHash = sha256(readFileSync(config));
    writeClaim('legacy-claim', 'legacy-1', config, {
      status: 'reserved',
      leaseTokenSha256: undefined,
      configSha256: configHash,
      reservationEvidenceSha256: sha256('legacy-census-record'),
    });

    expect(loadSessionConfigs(fleets, { admission: gate() }).has('legacy-1')).toBe(true);
    writeFileSync(config, `${readFileSync(config, 'utf8')}# drift\n`);
    expect(() => loadSessionConfigs(fleets, { admission: gate() })).toThrow(/YAML hash/);
  });

  it('refuses spawn without a leased token-bound claim or with a reservation claim', () => {
    const config = join(fleets, 'config', 'sessions', 'worker-1.yaml');
    expect(() => gate().assertSpawn('worker-1', undefined, config)).toThrow(/required/);
    writeClaim('reserved', 'worker-1', config, {
      status: 'reserved',
      leaseTokenSha256: undefined,
      configSha256: sha256('future'),
      reservationEvidenceSha256: sha256('legacy'),
    });
    expect(() => gate().assertSpawn('worker-1', 'reserved', config)).toThrow(/legacy reservation/);
  });
});
