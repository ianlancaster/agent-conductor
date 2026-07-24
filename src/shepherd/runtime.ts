import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ShepherdRuntimeStatus {
  version: 1;
  pid: number;
  launchToken: string;
  configPath: string;
  state: 'starting' | 'polling' | 'healthy' | 'failed';
  startedAt: string;
  lastPollStartedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  error?: string;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
}

export function runtimeStatusPath(databasePath: string): string {
  return `${databasePath}.runtime-status.json`;
}

export function serviceLockPath(databasePath: string): string {
  return `${databasePath}.lock`;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function shepherdLike(command: string): boolean {
  return command.includes('pr-shepherd') || command.includes('shepherd/cli.');
}

/**
 * Conservative database-lock identity check. An unreadable command for a live
 * PID blocks reclaim; false negatives here would permit duplicate mutations.
 */
export function processLooksLikeShepherd(pid: number): boolean {
  if (!processIsAlive(pid)) return false;
  const command = processCommand(pid);
  return command === undefined || shepherdLike(command);
}

/** Strong identity check used only before the manager sends a signal. */
export function processMatchesShepherd(pid: number, configPath: string): boolean {
  if (!processIsAlive(pid)) return false;
  const command = processCommand(pid);
  return command !== undefined && shepherdLike(command) && command.includes(resolve(configPath));
}

export class ShepherdServiceLock {
  private owned = false;

  constructor(
    private readonly path: string,
    private readonly configPath: string,
    private readonly pid = process.pid,
    private readonly launchToken = process.env.PR_SHEPHERD_LAUNCH_TOKEN ?? randomUUID(),
    private readonly blocksReclaim: (pid: number) => boolean = processLooksLikeShepherd,
  ) {}

  acquire(): void {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        this.create();
        this.owned = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const snapshot = this.readSnapshot(this.path);
        const owner = this.parseOwner(snapshot);
        if (owner !== undefined && this.blocksReclaim(owner.pid)) {
          throw new Error(`PR Shepherd is already running for ${owner.configPath} (pid ${String(owner.pid)}).`);
        }

        // Move the exact stale generation aside before replacing it. If a
        // winner replaced the path after our read, restore that generation
        // without overwriting a newer owner and re-evaluate.
        const stalePath = `${this.path}.stale-${String(this.pid)}-${randomUUID()}`;
        try {
          renameSync(this.path, stalePath);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw renameError;
        }
        const moved = this.readSnapshot(stalePath);
        if (moved !== snapshot) {
          try {
            linkSync(stalePath, this.path);
          } catch {
            // Another owner already filled the path; it is authoritative.
          }
          try {
            unlinkSync(stalePath);
          } catch {
            // The next acquisition re-evaluates the authoritative lock path.
          }
          continue;
        }
        try {
          this.create();
          this.owned = true;
          return;
        } catch (createError) {
          if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
        } finally {
          try {
            unlinkSync(stalePath);
          } catch {
            // The authoritative lock is already installed; a stale backup is harmless.
          }
        }
      }
    }
    throw new Error(`Could not acquire PR Shepherd service lock at ${this.path}.`);
  }

  assertOwned(): void {
    const owner = this.readOwner();
    if (
      !this.owned ||
      owner?.pid !== this.pid ||
      owner.launchToken !== this.launchToken ||
      resolve(owner.configPath) !== resolve(this.configPath)
    ) {
      this.owned = false;
      throw new Error(`PR Shepherd lost its service lock at ${this.path}; refusing to poll.`);
    }
  }

  release(): void {
    if (!this.owned) return;
    this.owned = false;
    const owner = this.readOwner();
    if (
      owner?.pid !== this.pid ||
      owner.launchToken !== this.launchToken ||
      resolve(owner.configPath) !== resolve(this.configPath)
    ) {
      return;
    }
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private readOwner(): { pid: number; launchToken: string; configPath: string } | undefined {
    return this.parseOwner(this.readSnapshot(this.path));
  }

  private create(): void {
    const fd = openSync(this.path, 'wx', 0o600);
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          pid: this.pid,
          launchToken: this.launchToken,
          configPath: resolve(this.configPath),
        }),
      );
    } finally {
      closeSync(fd);
    }
  }

  private readSnapshot(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  private parseOwner(raw: string | undefined): { pid: number; launchToken: string; configPath: string } | undefined {
    if (raw === undefined) return undefined;
    try {
      const value = JSON.parse(raw) as {
        pid?: unknown;
        launchToken?: unknown;
        configPath?: unknown;
      };
      return typeof value.pid === 'number' &&
        typeof value.launchToken === 'string' &&
        typeof value.configPath === 'string'
        ? { pid: value.pid, launchToken: value.launchToken, configPath: value.configPath }
        : undefined;
    } catch {
      return undefined;
    }
  }
}

export class ShepherdRuntimeReporter {
  readonly path: string;
  private value: ShepherdRuntimeStatus;

  constructor(databasePath: string, configPath: string, launchToken: string, pid = process.pid) {
    this.path = runtimeStatusPath(databasePath);
    this.value = {
      version: 1,
      pid,
      launchToken,
      configPath: resolve(configPath),
      state: 'starting',
      startedAt: new Date().toISOString(),
    };
    this.write();
  }

  pollStarted(): void {
    this.value = { ...this.value, state: 'polling', lastPollStartedAt: new Date().toISOString(), error: undefined };
    this.write();
  }

  pollSucceeded(): void {
    this.value = { ...this.value, state: 'healthy', lastSuccessAt: new Date().toISOString(), error: undefined };
    this.write();
  }

  pollFailed(error: unknown): void {
    this.value = {
      ...this.value,
      state: 'failed',
      lastFailureAt: new Date().toISOString(),
      error: boundedError(error),
    };
    this.write();
  }

  private write(): void {
    const temp = `${this.path}.${String(process.pid)}.tmp`;
    const directory = dirname(this.path);
    if (!existsSync(directory)) throw new Error(`PR Shepherd data directory does not exist: ${directory}`);
    writeFileSync(temp, `${JSON.stringify(this.value)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

export function readRuntimeStatus(path: string): ShepherdRuntimeStatus | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ShepherdRuntimeStatus;
    return value.version === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}
