import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const SHA256 = /^[0-9a-f]{64}$/;
const issuerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('operator'), id: z.string().min(1), role: z.literal('operator') }).strict(),
  z
    .object({
      type: z.literal('conductor_session'),
      id: z.string().min(1),
      fleet: z.string().min(1),
      role: z.literal('durable_coordinator'),
    })
    .strict(),
]);
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('conductor_signed_receipt'),
    algorithm: z.literal('Ed25519'),
    payload: z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal('conductor_session_status'),
        fleetId: z.string().min(1),
        conductorInstance: z.string().min(1),
        host: z.string().min(1),
        codename: z.string().min(1),
        issuedAt: z.string().min(1),
        expiresAt: z.string().min(1),
        nonce: z.string().min(16),
        idempotencyKey: z.string().min(1),
        resource: z
          .object({
            kind: z.string().min(1),
            namespace: z.string().min(1),
            key: z.string().min(1),
            owner: z.string().min(1),
          })
          .strict(),
        registered: z.boolean(),
        configPresent: z.boolean(),
        running: z.boolean(),
        activity: z.enum(['stopped', 'idle', 'working']),
        processActive: z.boolean().nullable(),
        processObservedAt: z.string().nullable(),
        issuer: issuerSchema,
      })
      .strict(),
    payloadSha256: z.string().regex(SHA256),
    publicKeyPath: z.string().min(1),
    publicKeySha256: z.string().regex(SHA256),
    keyId: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();

export interface SessionStatusAttestationPayload {
  schemaVersion: 1;
  kind: 'conductor_session_status';
  fleetId: string;
  conductorInstance: string;
  host: string;
  codename: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  idempotencyKey: string;
  resource: { kind: string; namespace: string; key: string; owner: string };
  registered: boolean;
  configPresent: boolean;
  running: boolean;
  activity: 'stopped' | 'idle' | 'working';
  processActive: boolean | null;
  processObservedAt: string | null;
  issuer:
    | { type: 'operator'; id: string; role: 'operator' }
    | { type: 'conductor_session'; id: string; fleet: string; role: 'durable_coordinator' };
}

export interface SignedSessionStatusReceipt {
  schemaVersion: 1;
  kind: 'conductor_signed_receipt';
  algorithm: 'Ed25519';
  payload: SessionStatusAttestationPayload;
  payloadSha256: string;
  publicKeyPath: string;
  publicKeySha256: string;
  keyId: string;
  signature: string;
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

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Persisted Ed25519 signer for connection-derived, tamper-evident recovery evidence. */
export class SessionStatusAttestor {
  private readonly directory: string;
  private readonly privateKeyPath: string;
  readonly publicKeyPath: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'attestations');
    this.privateKeyPath = join(this.directory, 'signing-key.pem');
    this.publicKeyPath = join(this.directory, 'signing-key.pub.pem');
  }

  attest(payload: SessionStatusAttestationPayload): {
    path: string;
    sha256: string;
    receipt: SignedSessionStatusReceipt;
  } {
    const requestIdentity = {
      fleetId: payload.fleetId,
      conductorInstance: payload.conductorInstance,
      host: payload.host,
      codename: payload.codename,
      idempotencyKey: payload.idempotencyKey,
      resource: payload.resource,
      issuer: payload.issuer,
    };
    const requestDigest = sha256(`${canonicalize(requestIdentity)}\n`);
    const requestsDirectory = join(this.directory, 'requests');
    mkdirSync(requestsDirectory, { recursive: true, mode: constants.S_IRWXU });
    const requestPath = join(requestsDirectory, `${requestDigest}.json`);
    if (existsSync(requestPath)) return this.loadIdempotentResult(requestPath, requestDigest);

    const { privateKey, publicPem } = this.keys();
    const payloadRaw = `${canonicalize(payload)}\n`;
    const receipt: SignedSessionStatusReceipt = {
      schemaVersion: 1,
      kind: 'conductor_signed_receipt',
      algorithm: 'Ed25519',
      payload,
      payloadSha256: sha256(payloadRaw),
      publicKeyPath: this.publicKeyPath,
      publicKeySha256: sha256(publicPem),
      keyId: `ed25519-${sha256(publicPem).slice(0, 16)}`,
      signature: sign(null, Buffer.from(payloadRaw), privateKey).toString('base64'),
    };
    const raw = `${canonicalize(receipt)}\n`;
    const digest = sha256(raw);
    const destination = join(this.directory, `session-status-${digest.slice(0, 16)}.json`);
    try {
      writeFileSync(destination, raw, { flag: 'wx', mode: constants.S_IRUSR | constants.S_IRGRP | constants.S_IROTH });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(destination, 'utf8') !== raw) throw error;
    }
    const index = { schemaVersion: 1, requestSha256: requestDigest, receiptPath: destination, receiptSha256: digest };
    try {
      writeFileSync(requestPath, `${canonicalize(index)}\n`, {
        flag: 'wx',
        mode: constants.S_IRUSR | constants.S_IRGRP | constants.S_IROTH,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return this.loadIdempotentResult(requestPath, requestDigest);
    }
    return { path: destination, sha256: digest, receipt };
  }

  private loadIdempotentResult(
    requestPath: string,
    expectedRequestDigest: string,
  ): { path: string; sha256: string; receipt: SignedSessionStatusReceipt } {
    const stat = lstatSync(requestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) {
      throw new Error('Attestation idempotency record is not immutable.');
    }
    const index = JSON.parse(readFileSync(requestPath, 'utf8')) as {
      schemaVersion?: unknown;
      requestSha256?: unknown;
      receiptPath?: unknown;
      receiptSha256?: unknown;
    };
    if (
      index.schemaVersion !== 1 ||
      index.requestSha256 !== expectedRequestDigest ||
      typeof index.receiptPath !== 'string' ||
      typeof index.receiptSha256 !== 'string' ||
      dirname(resolve(index.receiptPath)) !== resolve(this.directory)
    ) {
      throw new Error('Attestation idempotency record is invalid.');
    }
    const raw = readFileSync(index.receiptPath, 'utf8');
    if (sha256(raw) !== index.receiptSha256) throw new Error('Idempotent attestation receipt hash mismatch.');
    return {
      path: index.receiptPath,
      sha256: index.receiptSha256,
      receipt: JSON.parse(raw) as SignedSessionStatusReceipt,
    };
  }

  private keys(): { privateKey: ReturnType<typeof createPrivateKey>; publicPem: Buffer } {
    mkdirSync(this.directory, { recursive: true, mode: constants.S_IRWXU });
    if (!existsSync(this.privateKeyPath)) {
      const generated = generateKeyPairSync('ed25519');
      const privatePem = generated.privateKey.export({ format: 'pem', type: 'pkcs8' });
      const publicPem = generated.publicKey.export({ format: 'pem', type: 'spki' });
      try {
        writeFileSync(this.privateKeyPath, privatePem, { flag: 'wx', mode: constants.S_IRUSR | constants.S_IWUSR });
        writeFileSync(this.publicKeyPath, publicPem, {
          flag: 'wx',
          mode: constants.S_IRUSR | constants.S_IRGRP | constants.S_IROTH,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    for (const file of [this.privateKeyPath, this.publicKeyPath]) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Attestation key is not a regular file: ${file}`);
    }
    if ((lstatSync(this.privateKeyPath).mode & 0o077) !== 0) {
      throw new Error('Attestation private key permissions are too broad.');
    }
    const privateKey = createPrivateKey(readFileSync(this.privateKeyPath));
    const publicPem = readFileSync(this.publicKeyPath);
    const derivedPublic = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' });
    if (!Buffer.from(derivedPublic).equals(publicPem))
      throw new Error('Attestation public key does not match the private key.');
    return { privateKey, publicPem };
  }
}

export interface SessionStatusReceiptExpectations {
  pinnedPublicKeyPath: string;
  pinnedPublicKeySha256: string;
  fleetId: string;
  conductorInstance: string;
  host: string;
  codename: string;
  resourceKind: string;
  resourceNamespace: string;
  resourceKey: string;
  owner: string;
  allowOperator?: boolean;
  authorizedSessions?: ReadonlySet<string>;
  usedNonces?: ReadonlySet<string>;
  now?: Date;
}

export function verifySessionStatusReceipt(
  candidate: unknown,
  expectations: SessionStatusReceiptExpectations,
): boolean {
  const parsed = receiptSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const receipt = parsed.data;
  if (receipt.algorithm !== 'Ed25519' || receipt.kind !== 'conductor_signed_receipt') return false;
  if (resolve(receipt.publicKeyPath) !== resolve(expectations.pinnedPublicKeyPath)) return false;
  let publicPem: Buffer;
  try {
    const stat = lstatSync(receipt.publicKeyPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    publicPem = readFileSync(receipt.publicKeyPath);
  } catch {
    return false;
  }
  const publicHash = sha256(publicPem);
  if (publicHash !== receipt.publicKeySha256) return false;
  if (publicHash !== expectations.pinnedPublicKeySha256) return false;
  if (receipt.keyId !== `ed25519-${publicHash.slice(0, 16)}`) return false;
  const payloadRaw = `${canonicalize(receipt.payload)}\n`;
  if (sha256(payloadRaw) !== receipt.payloadSha256) return false;
  try {
    if (!verify(null, Buffer.from(payloadRaw), createPublicKey(publicPem), Buffer.from(receipt.signature, 'base64'))) {
      return false;
    }
  } catch {
    return false;
  }
  const payload = receipt.payload;
  if (
    payload.fleetId !== expectations.fleetId ||
    payload.conductorInstance !== expectations.conductorInstance ||
    payload.host !== expectations.host ||
    payload.codename !== expectations.codename ||
    payload.resource.kind !== expectations.resourceKind ||
    payload.resource.namespace !== expectations.resourceNamespace ||
    payload.resource.key !== expectations.resourceKey ||
    payload.resource.owner !== expectations.owner
  ) {
    return false;
  }
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const now = (expectations.now ?? new Date()).getTime();
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    now < issuedAt ||
    now > expiresAt
  ) {
    return false;
  }
  if (payload.nonce.length < 16 || payload.idempotencyKey.length < 1 || expectations.usedNonces?.has(payload.nonce)) {
    return false;
  }
  if (payload.issuer.type === 'operator') {
    return payload.issuer.role === 'operator' && expectations.allowOperator === true;
  }
  return (
    payload.issuer.role === 'durable_coordinator' &&
    payload.issuer.fleet === expectations.fleetId &&
    expectations.authorizedSessions?.has(payload.issuer.id) === true
  );
}
