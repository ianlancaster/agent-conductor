import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { SessionConfig, SupervisorConfig } from './schema.js';

const SHA256 = /^[0-9a-f]{64}$/;
const CLAIM_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

const admissionClaimSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('conductor_session_admission_claim'),
    claimId: z.string().regex(CLAIM_ID),
    status: z.enum(['leased', 'reserved']),
    fleetId: z.string().trim().min(1),
    conductorInstance: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    ownerSha256: z.string().regex(SHA256),
    resourceKind: z.string().regex(CLAIM_ID),
    resourceNamespace: z.string().regex(CLAIM_ID),
    resourceKey: z.string().regex(CLAIM_ID),
    codename: z.string().trim().min(1),
    configPath: z.string().trim().min(1),
    leaseTokenSha256: z.string().regex(SHA256).optional(),
    configSha256: z.string().regex(SHA256).optional(),
    reservationEvidenceSha256: z.string().regex(SHA256).optional(),
  })
  .strict()
  .superRefine((claim, context) => {
    if (claim.status === 'leased' && claim.leaseTokenSha256 === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leaseTokenSha256'],
        message: 'is required for leased claims',
      });
    }
    if (claim.status === 'reserved') {
      if (claim.configSha256 === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['configSha256'],
          message: 'is required for reserved claims',
        });
      }
      if (claim.reservationEvidenceSha256 === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reservationEvidenceSha256'],
          message: 'is required for reserved claims',
        });
      }
    }
  });

export type SessionAdmissionClaim = z.infer<typeof admissionClaimSchema>;

export interface SessionAdmissionGate {
  readonly enabled: boolean;
  assertConfiguredSession(configFile: string, session: SessionConfig): void;
  assertSpawn(
    codename: string,
    claimId: string | undefined,
    configFile: string,
  ): { kind: string; namespace: string; key: string } | undefined;
}

function sha256(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
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

function formatClaimError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Config-driven admission seam for external host-resource allocators.
 *
 * Conductor never allocates or releases the external resource. It only refuses
 * registration and launch unless the fleet's claim issuer has already written
 * a matching claim. This keeps resource policy outside the reusable core while
 * closing direct-spawn and config-hot-load bypasses.
 */
export class SessionClaimAdmission implements SessionAdmissionGate {
  readonly enabled: boolean;
  private readonly claimDirectory: string | undefined;
  private readonly owner: string | undefined;
  private readonly fleetId: string;
  private readonly conductorInstance: string;

  constructor(
    config: SupervisorConfig['admission']['sessionClaims'],
    baseDir: string,
    fleetId: string,
    conductorInstance = 'default',
  ) {
    this.enabled = config.enabled;
    this.claimDirectory =
      config.claimDirectory === null
        ? undefined
        : isAbsolute(config.claimDirectory)
          ? resolve(config.claimDirectory)
          : resolve(baseDir, config.claimDirectory);
    this.owner = config.owner ?? undefined;
    this.fleetId = fleetId;
    this.conductorInstance = conductorInstance;
    if (this.enabled && (this.claimDirectory === undefined || this.owner === undefined)) {
      throw new Error('Session claim admission requires claimDirectory and owner.');
    }
    if (this.claimDirectory !== undefined) {
      const stat = lstatSync(this.claimDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Session admission claim directory is not a real directory: ${this.claimDirectory}`);
      }
    }
  }

  assertConfiguredSession(configFile: string, session: SessionConfig): void {
    if (!this.enabled) {
      // Staged claims are inert while enforcement is disabled: a disabled gate grants
      // nothing, so accepting the fields cannot widen access. This lets a coordinator
      // allocate a seat and register its YAML before the fleet activates admission;
      // enabling enforcement applies the full validation below to the same YAML.
      return;
    }
    const configStat = lstatSync(configFile);
    if (!configStat.isFile() || configStat.isSymbolicLink()) {
      throw new Error(`Session admission denied: config is not a regular file: ${configFile}`);
    }
    const filenameCodename = basename(configFile, extname(configFile));
    if (filenameCodename !== session.codename) {
      throw new Error(
        `Session admission denied: YAML filename '${filenameCodename}' does not match codename '${session.codename}'.`,
      );
    }
    const claim = this.loadClaim(session.admissionClaim);
    this.assertIdentity(claim, session.codename, configFile);
    if (
      session.admissionResource?.namespace !== claim.resourceNamespace ||
      session.admissionResource?.key !== claim.resourceKey ||
      session.admissionResource?.kind !== claim.resourceKind
    ) {
      throw new Error(`Session admission denied: YAML resource identity does not match claim '${claim.claimId}'.`);
    }
    if (claim.status === 'reserved') {
      const actualHash = sha256(readFileSync(configFile));
      if (claim.configSha256 !== actualHash) {
        throw new Error(`Session admission denied: reserved claim '${claim.claimId}' does not match the YAML hash.`);
      }
    }
  }

  assertSpawn(
    codename: string,
    claimId: string | undefined,
    configFile: string,
  ): { kind: string; namespace: string; key: string } | undefined {
    if (!this.enabled) {
      if (claimId !== undefined) {
        throw new Error('Session admission claim was supplied, but supervisor admission.sessionClaims is disabled.');
      }
      return undefined;
    }
    const claim = this.loadClaim(claimId);
    this.assertIdentity(claim, codename, configFile);
    if (claim.status !== 'leased') {
      throw new Error(`Session admission denied: claim '${claim.claimId}' is a legacy reservation, not a spawn lease.`);
    }
    return { kind: claim.resourceKind, namespace: claim.resourceNamespace, key: claim.resourceKey };
  }

  private loadClaim(claimId: string | undefined): SessionAdmissionClaim {
    if (claimId === undefined) throw new Error('Session admission denied: admissionClaim is required.');
    if (!CLAIM_ID.test(claimId)) throw new Error(`Session admission denied: invalid claim ID '${claimId}'.`);
    const file = join(this.claimDirectory!, `${claimId}.json`);
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      throw new Error(`Session admission denied: claim '${claimId}' does not exist.`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Session admission denied: claim '${claimId}' is not a regular file.`);
    }
    if (stat.size > 16_384) throw new Error(`Session admission denied: claim '${claimId}' exceeds 16 KiB.`);
    let parsed: unknown;
    const raw = readFileSync(file, 'utf8');
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Session admission denied: claim '${claimId}' is not valid JSON.`);
    }
    const result = admissionClaimSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Session admission denied: invalid claim '${claimId}': ${formatClaimError(result.error)}`);
    }
    if (raw !== `${canonicalize(result.data)}\n`) {
      throw new Error(`Session admission denied: claim '${claimId}' is not canonical JSON.`);
    }
    if ((stat.mode & 0o222) !== 0) {
      throw new Error(`Session admission denied: claim '${claimId}' is mutable.`);
    }
    if (result.data.claimId !== claimId) {
      throw new Error(`Session admission denied: claim filename and claimId differ for '${claimId}'.`);
    }
    return result.data;
  }

  private assertIdentity(claim: SessionAdmissionClaim, codename: string, configFile: string): void {
    if (claim.fleetId !== this.fleetId || claim.conductorInstance !== this.conductorInstance) {
      throw new Error(`Session admission denied: claim '${claim.claimId}' belongs to another Conductor instance.`);
    }
    if (claim.owner !== this.owner) {
      throw new Error(`Session admission denied: claim '${claim.claimId}' belongs to another owner.`);
    }
    if (claim.ownerSha256 !== sha256(claim.owner)) {
      throw new Error(`Session admission denied: claim '${claim.claimId}' owner hash is invalid.`);
    }
    if (claim.codename !== codename) {
      throw new Error(`Session admission denied: claim '${claim.claimId}' belongs to codename '${claim.codename}'.`);
    }
    if (!isAbsolute(claim.configPath) || resolve(claim.configPath) !== resolve(configFile)) {
      throw new Error(`Session admission denied: claim '${claim.claimId}' names another config path.`);
    }
  }
}
