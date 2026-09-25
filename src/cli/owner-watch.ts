import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Environment handed to a Conductor that `conductor restart` launches on behalf
 * of an operator console. The replacement is not the console's child, so it
 * watches the console itself and stops when the console closes, preserving
 * "closing the console stops its Conductor".
 */
export const OWNER_PID_ENV = 'CONDUCTOR_OWNER_PID';
export const OWNER_START_ENV = 'CONDUCTOR_OWNER_START';

const OWNER_POLL_MS = 5_000;

export interface OwnerWatchOptions {
  pid: number;
  /** Process start token recorded at launch; a different token means the PID was reused. */
  startToken?: string;
  onGone: () => void;
  /** Resolves the owner's current start token, or undefined when it is gone. */
  probe?: (pid: number) => Promise<string | undefined>;
  intervalMs?: number;
}

function probeStartToken(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
      const token = stdout.trim();
      resolve(error === null && token.length > 0 ? token : undefined);
    });
  });
}

/** Read and remove the owner handoff so it never leaks into panes or child processes. */
export function takeOwnerFromEnvironment(env: NodeJS.ProcessEnv): { pid: number; startToken?: string } | undefined {
  const pid = Number.parseInt(env[OWNER_PID_ENV] ?? '', 10);
  const startToken = env[OWNER_START_ENV];
  delete env[OWNER_PID_ENV];
  delete env[OWNER_START_ENV];
  if (!Number.isSafeInteger(pid) || pid < 2) return undefined;
  return startToken === undefined || startToken.length === 0 ? { pid } : { pid, startToken };
}

/** Poll the owner asynchronously; call `onGone` once when it exits or its PID is reused. */
export function watchOwner(options: OwnerWatchOptions): () => void {
  const probe = options.probe ?? probeStartToken;
  let checking = false;
  let done = false;
  const timer = setInterval(() => {
    if (checking || done) return;
    checking = true;
    void probe(options.pid)
      .then((token) => {
        if (done) return;
        if (token === undefined || (options.startToken !== undefined && token !== options.startToken)) {
          done = true;
          clearInterval(timer);
          options.onGone();
        }
      })
      .finally(() => {
        checking = false;
      });
  }, options.intervalMs ?? OWNER_POLL_MS);
  timer.unref();
  return () => {
    done = true;
    clearInterval(timer);
  };
}

/**
 * Console ownership of a Conductor launched by `conductor restart`, kept in the
 * data directory so a later restart still knows the console: the replacement
 * is detached, so its parent process no longer identifies the console.
 */
export interface OwnerRecord {
  conductorPid: number;
  consolePid: number;
  consoleStartToken?: string;
  consoleTty?: string;
}

export function writeOwnerRecord(path: string, record: OwnerRecord): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function readOwnerRecord(path: string): OwnerRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerRecord>;
    if (typeof parsed.conductorPid !== 'number' || typeof parsed.consolePid !== 'number') return undefined;
    return {
      conductorPid: parsed.conductorPid,
      consolePid: parsed.consolePid,
      ...(typeof parsed.consoleStartToken === 'string' ? { consoleStartToken: parsed.consoleStartToken } : {}),
      ...(typeof parsed.consoleTty === 'string' ? { consoleTty: parsed.consoleTty } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Remove the record only while it still names this Conductor. */
export function clearOwnerRecord(path: string, conductorPid: number): void {
  if (readOwnerRecord(path)?.conductorPid === conductorPid) rmSync(path, { force: true });
}
