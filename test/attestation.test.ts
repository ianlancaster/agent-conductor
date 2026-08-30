import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SessionStatusAttestor,
  verifySessionStatusReceipt,
  type SessionStatusAttestationPayload,
} from '../src/core/attestation.js';

let root: string;
let attestor: SessionStatusAttestor;

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function payload(overrides: Partial<SessionStatusAttestationPayload> = {}): SessionStatusAttestationPayload {
  return {
    schemaVersion: 1,
    kind: 'conductor_session_status',
    fleetId: 'fleet-one-id',
    conductorInstance: 'default',
    host: 'build-host.example',
    codename: 'worker-1',
    issuedAt: '2026-08-30T20:00:00.000Z',
    expiresAt: '2026-08-30T20:05:00.000Z',
    nonce: '5de89976-3d4e-45a3-a098-379d8aa2b013',
    idempotencyKey: 'recovery-worker-1-001',
    resource: { kind: 'exclusive', namespace: 'dev-port-block', key: 'instance-1', owner: 'fleet-one' },
    registered: true,
    configPresent: true,
    running: false,
    activity: 'stopped',
    processActive: false,
    processObservedAt: '2026-08-30T19:59:59.000Z',
    issuer: { type: 'conductor_session', id: 'coordinator', fleet: 'fleet-one-id', role: 'durable_coordinator' },
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conductor-attestation-'));
  attestor = new SessionStatusAttestor(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function expectations(publicKeySha256: string) {
  return {
    pinnedPublicKeyPath: attestor.publicKeyPath,
    pinnedPublicKeySha256: publicKeySha256,
    fleetId: 'fleet-one-id',
    conductorInstance: 'default',
    host: 'build-host.example',
    codename: 'worker-1',
    resourceKind: 'exclusive',
    resourceNamespace: 'dev-port-block',
    resourceKey: 'instance-1',
    owner: 'fleet-one',
    authorizedSessions: new Set(['coordinator']),
    now: new Date('2026-08-30T20:01:00.000Z'),
  };
}

describe('signed session status receipts', () => {
  it('binds the host, fleet, instance, target, resource, requester, freshness, and idempotency', () => {
    const first = attestor.attest(payload());
    const pinned = sha256(readFileSync(attestor.publicKeyPath));
    expect(verifySessionStatusReceipt(first.receipt, expectations(pinned))).toBe(true);
    expect(attestor.attest(payload()).path).toBe(first.path);

    for (const changed of [
      { fleetId: 'other' },
      { conductorInstance: 'other' },
      { host: 'other' },
      { codename: 'other' },
      { resourceKind: 'other' },
      { resourceNamespace: 'other' },
      { resourceKey: 'other' },
      { owner: 'other' },
    ]) {
      expect(verifySessionStatusReceipt(first.receipt, { ...expectations(pinned), ...changed })).toBe(false);
    }
    expect(
      verifySessionStatusReceipt(first.receipt, {
        ...expectations(pinned),
        usedNonces: new Set([first.receipt.payload.nonce]),
      }),
    ).toBe(false);
    expect(
      verifySessionStatusReceipt(first.receipt, { ...expectations(pinned), now: new Date('2026-08-30T20:06:00.000Z') }),
    ).toBe(false);
    expect(
      verifySessionStatusReceipt(first.receipt, { ...expectations(pinned), now: new Date('2026-08-30T19:59:00.000Z') }),
    ).toBe(false);
    expect(
      verifySessionStatusReceipt(first.receipt, { ...expectations(pinned), pinnedPublicKeySha256: sha256('rotated') }),
    ).toBe(false);
    expect(
      verifySessionStatusReceipt(first.receipt, { ...expectations(pinned), authorizedSessions: new Set(['spoofed']) }),
    ).toBe(false);
  });

  it('rejects altered bodies, signatures, unknown keys, and unauthorized operator receipts', () => {
    const signed = attestor.attest(payload());
    const pinned = sha256(readFileSync(attestor.publicKeyPath));
    const alteredBody = structuredClone(signed.receipt);
    alteredBody.payload.running = true;
    expect(verifySessionStatusReceipt(alteredBody, expectations(pinned))).toBe(false);
    const alteredSignature = structuredClone(signed.receipt);
    alteredSignature.signature = Buffer.from('altered').toString('base64');
    expect(verifySessionStatusReceipt(alteredSignature, expectations(pinned))).toBe(false);

    const operator = attestor.attest(
      payload({ idempotencyKey: 'operator-001', issuer: { type: 'operator', id: 'local-operator', role: 'operator' } }),
    );
    expect(verifySessionStatusReceipt(operator.receipt, expectations(pinned))).toBe(false);
    expect(verifySessionStatusReceipt(operator.receipt, { ...expectations(pinned), allowOperator: true })).toBe(true);

    chmodSync(attestor.publicKeyPath, 0o644);
    const wrongKey = structuredClone(signed.receipt);
    wrongKey.publicKeyPath = join(root, 'missing-key.pem');
    expect(verifySessionStatusReceipt(wrongKey, expectations(pinned))).toBe(false);
  });
});
