import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { log } from '../logger.js';
import { CODENAME_PATTERN, FEDERATION_NAME_PATTERN } from '../config/schema.js';

export const FEDERATION_PROTOCOL_VERSION = 1;

export interface FederationPeerRecord {
  name: string;
  host: string;
  port: number;
  pid: number;
  protocol: number;
  sessions: string[];
}

export interface FederationRegistryOptions {
  name: string;
  host: string;
  port: number;
  sessions(): readonly string[];
  /** Deterministic test/embedding seam; production resolves XDG-or-home. */
  directory?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  pid?: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseRecord(raw: string): FederationPeerRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<FederationPeerRecord>;
    if (
      typeof value.name !== 'string' ||
      !FEDERATION_NAME_PATTERN.test(value.name) ||
      typeof value.host !== 'string' ||
      !['127.0.0.1', 'localhost'].includes(value.host) ||
      typeof value.port !== 'number' ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65_535 ||
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.protocol !== 'number' ||
      !Number.isInteger(value.protocol) ||
      !Array.isArray(value.sessions) ||
      value.sessions.some((session) => typeof session !== 'string' || !CODENAME_PATTERN.test(session))
    ) {
      return undefined;
    }
    return {
      name: value.name,
      host: value.host,
      port: value.port,
      pid: value.pid,
      protocol: value.protocol,
      sessions: [...new Set(value.sessions)].sort(),
    };
  } catch {
    return undefined;
  }
}

export class FederationRegistry {
  private directory: string | undefined;
  private claimed = false;
  private snapshotRecords: FederationPeerRecord[] = [];
  private readonly incompatibleLogged = new Set<string>();
  private readonly pid: number;

  constructor(private readonly options: FederationRegistryOptions) {
    if (!FEDERATION_NAME_PATTERN.test(options.name)) throw new Error(`Invalid federation name '${options.name}'.`);
    this.pid = options.pid ?? process.pid;
  }

  async claim(): Promise<void> {
    const path = await this.recordPath();
    const record = this.localRecord();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(path, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
        this.claimed = true;
        await this.list();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.readPath(path);
        if (existing !== undefined && isProcessAlive(existing.pid)) {
          throw new Error(
            `Federation fleet '${this.options.name}' is already registered by live process ${String(existing.pid)}.`,
          );
        }
        if (existing === undefined) await this.removeMalformed(path);
        else await this.removeIfOwnedBy(path, existing.pid);
      }
    }
    throw new Error(`Could not claim federation fleet name '${this.options.name}' after removing a stale record.`);
  }

  async update(): Promise<void> {
    if (!this.claimed) return;
    const path = await this.recordPath();
    const current = await this.readPath(path);
    if (current?.pid !== this.pid) {
      throw new Error(
        `Lost federation registry ownership for '${this.options.name}'; stop the duplicate fleet and restart this Conductor.`,
      );
    }
    const temporary = `${path}.${String(this.pid)}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.localRecord())}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async list(): Promise<FederationPeerRecord[]> {
    const directory = await this.resolveDirectory();
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      this.snapshotRecords = [];
      return [];
    }
    const peers: FederationPeerRecord[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const path = join(directory, entry);
      const record = await this.readPath(path);
      if (record === undefined) {
        await this.removeMalformed(path);
        continue;
      }
      if (record.name !== basename(entry, '.json')) {
        await this.removeIfUnchanged(path);
        continue;
      }
      if (!isProcessAlive(record.pid)) {
        await this.removeIfOwnedBy(path, record.pid);
        continue;
      }
      if (record.protocol !== FEDERATION_PROTOCOL_VERSION) {
        if (!this.incompatibleLogged.has(record.name)) {
          this.incompatibleLogged.add(record.name);
          log().warn(
            'federation',
            `Ignoring fleet '${record.name}' with protocol ${String(record.protocol)}; local protocol is ${String(FEDERATION_PROTOCOL_VERSION)}.`,
          );
        }
        continue;
      }
      peers.push(record);
    }
    this.snapshotRecords = peers.sort((left, right) => left.name.localeCompare(right.name));
    return this.snapshot();
  }

  snapshot(): FederationPeerRecord[] {
    return this.snapshotRecords.map((record) => ({ ...record, sessions: [...record.sessions] }));
  }

  async peer(name: string): Promise<FederationPeerRecord | undefined> {
    return (await this.list()).find((peer) => peer.name === name);
  }

  async release(): Promise<void> {
    if (!this.claimed) return;
    const path = await this.recordPath();
    await this.removeIfOwnedBy(path, this.pid);
    this.claimed = false;
    this.snapshotRecords = this.snapshotRecords.filter((record) => record.name !== this.options.name);
  }

  private localRecord(): FederationPeerRecord {
    return {
      name: this.options.name,
      host: this.options.host === '0.0.0.0' || this.options.host === '::' ? '127.0.0.1' : this.options.host,
      port: this.options.port,
      pid: this.pid,
      protocol: FEDERATION_PROTOCOL_VERSION,
      sessions: [...new Set(this.options.sessions())].sort(),
    };
  }

  private async resolveDirectory(): Promise<string> {
    if (this.directory !== undefined) return this.directory;
    if (this.options.directory !== undefined) {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      this.directory = this.options.directory;
      return this.directory;
    }
    const env = this.options.env ?? process.env;
    const xdg = env.XDG_RUNTIME_DIR;
    if (xdg !== undefined && xdg.length > 0) {
      const candidate = join(xdg, 'agent-conductor', 'federation');
      try {
        await mkdir(candidate, { recursive: true, mode: 0o700 });
        await access(candidate, constants.W_OK);
        this.directory = candidate;
        return candidate;
      } catch {
        // Fall through to the stable per-user home path.
      }
    }
    const candidate = join(this.options.homeDirectory ?? homedir(), '.agent-conductor', 'federation');
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    this.directory = candidate;
    return candidate;
  }

  private async recordPath(): Promise<string> {
    return join(await this.resolveDirectory(), `${this.options.name}.json`);
  }

  private async readPath(path: string): Promise<FederationPeerRecord | undefined> {
    try {
      return parseRecord(await readFile(path, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private async removeIfOwnedBy(path: string, pid: number): Promise<void> {
    try {
      const current = await this.readPath(path);
      if (current?.pid !== pid) return;
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async removeMalformed(path: string): Promise<void> {
    try {
      const first = await readFile(path, 'utf8');
      if (parseRecord(first) !== undefined) return;
      const second = await readFile(path, 'utf8');
      if (second !== first) return;
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async removeIfUnchanged(path: string): Promise<void> {
    try {
      const first = await readFile(path, 'utf8');
      const second = await readFile(path, 'utf8');
      if (second !== first) return;
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
