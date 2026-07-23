import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { FEDERATION_PROTOCOL_VERSION, FederationError } from './types.js';
import { FEDERATION_NAME_PATTERN } from '../config/schema.js';
import { log } from '../logger.js';
import { hasControlCharacters } from '../text.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LocalRegistryRecord {
  version: typeof FEDERATION_PROTOCOL_VERSION;
  instanceId: string;
  fleet: string;
  description?: string;
  endpoint: string;
  pid: number;
  credential: string;
  startedAt: number;
  heartbeatAt: number;
}

export interface LocalRegistryOptions {
  registryDir: string;
  instanceId: string;
  fleet: string;
  description?: string;
  endpoint: string;
  heartbeatMs: number;
  staleAfterMs: number;
  now?: () => number;
  pid?: number;
  pidAlive?: (pid: number) => boolean;
}

export interface LocalRegistryHealth {
  lastHeartbeatAt: number | null;
  lastErrorCode: string | null;
}

/** Same-UID discovery registry. The credential is identity hygiene, not a sandbox boundary. */
export class LocalFederationRegistry {
  private readonly now: () => number;
  private readonly pid: number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly credential = randomBytes(32).toString('base64url');
  private readonly startedAt: number;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private lastHeartbeatAt: number | null = null;
  private lastErrorCode: string | null = null;

  constructor(private readonly options: LocalRegistryOptions) {
    if (!UUID_PATTERN.test(options.instanceId)) {
      throw new Error('Local federation instanceId must be a UUID.');
    }
    if (!FEDERATION_NAME_PATTERN.test(options.fleet) || options.fleet.length > 63) {
      throw new Error('Local federation name must be a lowercase slug.');
    }
    if (
      options.description !== undefined &&
      (options.description.trim().length === 0 ||
        options.description.length > 200 ||
        hasControlCharacters(options.description))
    ) {
      throw new Error('Local federation description must be between 1 and 200 characters.');
    }
    if (!isLoopbackFederationEndpoint(options.endpoint)) {
      throw new Error('Local federation endpoint must be an http://127.0.0.1 URL under /federation/v1.');
    }
    if (
      !Number.isFinite(options.heartbeatMs) ||
      options.heartbeatMs <= 0 ||
      !Number.isFinite(options.staleAfterMs) ||
      options.staleAfterMs <= options.heartbeatMs
    ) {
      throw new Error('Local federation staleAfterMs must be greater than heartbeatMs.');
    }
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    if (!Number.isInteger(this.pid) || this.pid <= 0) throw new Error('Local federation pid must be positive.');
    this.pidAlive = options.pidAlive ?? isPidAlive;
    this.startedAt = this.now();
  }

  ownRecord(): LocalRegistryRecord {
    return {
      version: FEDERATION_PROTOCOL_VERSION,
      instanceId: this.options.instanceId,
      fleet: this.options.fleet,
      ...(this.options.description !== undefined ? { description: this.options.description } : {}),
      endpoint: this.options.endpoint,
      pid: this.pid,
      credential: this.credential,
      startedAt: this.startedAt,
      heartbeatAt: this.now(),
    };
  }

  start(): void {
    mkdirSync(this.options.registryDir, { recursive: true, mode: 0o700 });
    chmodSync(this.options.registryDir, 0o700);
    this.pruneStale();
    this.assertInstanceAvailable();
    this.assertNameAvailable();
    this.writeOwnRecord();
    this.lastHeartbeatAt = this.now();
    try {
      this.assertOwnRecord();
      this.assertNameAvailable();
    } catch (error) {
      this.removeOwnRecord();
      throw error;
    }
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, this.options.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  stop(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.removeOwnRecord();
  }

  records(): LocalRegistryRecord[] {
    this.pruneStale();
    return this.readRecords().filter((record) => this.isDiscoverable(record));
  }

  findByCredential(credential: string): LocalRegistryRecord | undefined {
    return this.records().find((record) => record.credential === credential);
  }

  health(): LocalRegistryHealth {
    return { lastHeartbeatAt: this.lastHeartbeatAt, lastErrorCode: this.lastErrorCode };
  }

  updateDescription(description: string | undefined): void {
    if (
      description !== undefined &&
      (description.trim().length === 0 || description.length > 200 || hasControlCharacters(description))
    ) {
      throw new Error('Local federation description must be between 1 and 200 characters without controls.');
    }
    if (description === undefined) delete this.options.description;
    else this.options.description = description;
    this.heartbeat();
  }

  private recordPath(instanceId = this.options.instanceId): string {
    return join(this.options.registryDir, `${instanceId}.json`);
  }

  private writeOwnRecord(): void {
    const destination = this.recordPath();
    const temporary = join(
      this.options.registryDir,
      `.${this.options.instanceId}.${String(this.pid)}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const handle = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify(this.ownRecord())}\n`, 'utf8');
    } catch (error) {
      closeSync(handle);
      rmSync(temporary, { force: true });
      throw error;
    }
    closeSync(handle);
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  }

  private removeOwnRecord(): void {
    const path = this.recordPath();
    const current = readRecord(path);
    if (
      current?.instanceId === this.options.instanceId &&
      current.pid === this.pid &&
      current.startedAt === this.startedAt &&
      current.credential === this.credential
    ) {
      rmSync(path, { force: true });
    }
  }

  private assertInstanceAvailable(): void {
    const existing = readRecord(this.recordPath());
    if (existing !== undefined && this.isDiscoverable(existing)) {
      throw new FederationError(
        'instance_collision',
        `Local federation instance ${this.options.instanceId} is already live in another process.`,
      );
    }
  }

  private assertOwnRecord(): void {
    const current = readRecord(this.recordPath());
    if (
      current?.instanceId !== this.options.instanceId ||
      current.pid !== this.pid ||
      current.startedAt !== this.startedAt ||
      current.credential !== this.credential
    ) {
      throw new FederationError(
        'instance_collision',
        `Local federation instance ${this.options.instanceId} was claimed concurrently.`,
      );
    }
  }

  private assertOwnRecordOrMissing(): void {
    const current = readRecord(this.recordPath());
    if (current === undefined) return;
    if (
      current.instanceId !== this.options.instanceId ||
      current.pid !== this.pid ||
      current.startedAt !== this.startedAt ||
      current.credential !== this.credential
    ) {
      throw new FederationError(
        'instance_collision',
        `Local federation instance ${this.options.instanceId} was claimed by another process.`,
      );
    }
  }

  private assertNameAvailable(): void {
    const collision = this.readRecords().find(
      (record) =>
        record.fleet === this.options.fleet &&
        record.instanceId !== this.options.instanceId &&
        this.isDiscoverable(record),
    );
    if (collision !== undefined) {
      throw new FederationError(
        'instance_collision',
        `Local federation name '${this.options.fleet}' is already used by live instance ${collision.instanceId}. ` +
          `Set a unique federation.name in .conductor/config/supervisor.yaml.`,
      );
    }
  }

  private pruneStale(): void {
    const cutoff = this.now() - this.options.staleAfterMs;
    for (const record of this.readRecords()) {
      if (record.heartbeatAt >= cutoff) continue;
      const path = this.recordPath(record.instanceId);
      const rechecked = readRecord(path);
      if (rechecked !== undefined && rechecked.heartbeatAt < cutoff) rmSync(path, { force: true });
    }
  }

  private heartbeat(): void {
    try {
      this.pruneStale();
      this.assertOwnRecordOrMissing();
      this.assertNameAvailable();
      this.writeOwnRecord();
      this.assertOwnRecord();
      this.assertNameAvailable();
      this.lastHeartbeatAt = this.now();
      this.lastErrorCode = null;
    } catch (error) {
      const code = error instanceof FederationError ? error.code : 'registry_io';
      if (code === 'instance_collision') this.removeOwnRecord();
      if (this.lastErrorCode !== code) logRegistryFailure(code);
      this.lastErrorCode = code;
    }
  }

  private readRecords(): LocalRegistryRecord[] {
    if (!existsSync(this.options.registryDir)) return [];
    const records: LocalRegistryRecord[] = [];
    for (const entry of readdirSync(this.options.registryDir)) {
      if (!entry.endsWith('.json')) continue;
      const record = readRecord(join(this.options.registryDir, entry));
      if (record !== undefined && entry === `${record.instanceId}.json`) records.push(record);
    }
    return records;
  }

  private isDiscoverable(record: LocalRegistryRecord): boolean {
    return record.heartbeatAt >= this.now() - this.options.staleAfterMs && this.pidAlive(record.pid);
  }
}

function logRegistryFailure(code: string): void {
  log().warn('federation', `Local registry heartbeat failed (${code}); will retry.`);
}

function readRecord(path: string): LocalRegistryRecord | undefined {
  try {
    if (statSync(path).size > 8 * 1024) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRegistryRecord(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function isRegistryRecord(value: unknown): value is LocalRegistryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === FEDERATION_PROTOCOL_VERSION &&
    typeof record.instanceId === 'string' &&
    UUID_PATTERN.test(record.instanceId) &&
    typeof record.fleet === 'string' &&
    FEDERATION_NAME_PATTERN.test(record.fleet) &&
    (record.description === undefined ||
      (typeof record.description === 'string' &&
        record.description.length > 0 &&
        record.description.length <= 200 &&
        !hasControlCharacters(record.description))) &&
    typeof record.endpoint === 'string' &&
    isLoopbackFederationEndpoint(record.endpoint) &&
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.credential === 'string' &&
    record.credential.length >= 40 &&
    typeof record.startedAt === 'number' &&
    Number.isFinite(record.startedAt) &&
    typeof record.heartbeatAt === 'number' &&
    Number.isFinite(record.heartbeatAt)
  );
}

function isLoopbackFederationEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.pathname === '/federation/v1'
    );
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
