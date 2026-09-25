import { execFile, spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { platform, userInfo } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { isProcessAlive, processStartToken, readFleetLock } from '../core/lock.js';
import { buildIdentity } from '../version.js';
import { launchdLabel, launchdPlistPath, systemdUnit, systemdUnitPath } from './daemon.js';
import { killFleetConductor, parentPid, processMatchesFleetConsole, processTty } from './kill.js';
import { OWNER_PID_ENV, OWNER_START_ENV } from './owner-watch.js';

/** How the running Conductor was launched, which decides how it is replaced. */
export type ConductorHost =
  | { kind: 'none' }
  | { kind: 'service'; manager: 'launchd' | 'systemd'; name: string; pid: number }
  | { kind: 'console'; pid: number; consolePid: number; consoleTty?: string; consoleStartToken?: string }
  | { kind: 'foreground'; pid: number };

export interface HealthIdentity {
  pid?: number;
  version?: string;
  build?: string | null;
}

export interface SpawnedReplacement {
  pid: number | undefined;
  exited(): boolean;
}

export interface RestartDependencies {
  /** PID of the live process holding the fleet lock, if any. */
  lockOwner(): number | undefined;
  /** The running Conductor's /health identity, or undefined when nothing answers. */
  health(): Promise<HealthIdentity | undefined>;
  detectHost(pid: number): Promise<ConductorHost>;
  restartService(host: Extract<ConductorHost, { kind: 'service' }>): Promise<void>;
  /** Gracefully stop the lock owner through the same path as `conductor kill`. */
  stop(): Promise<void>;
  spawnReplacement(env: NodeJS.ProcessEnv): SpawnedReplacement;
  env: NodeJS.ProcessEnv;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface RestartOptions {
  fleetLabel: string;
  logPath: string;
  recoveryHint: string;
  timeoutMs?: number;
}

export interface RestartResult {
  ok: boolean;
  message: string;
}

export const RESTART_TIMEOUT_MS = 45_000;
const RESTART_POLL_MS = 250;

/**
 * Variables a Conductor runtime or terminal multiplexer sets inside a managed
 * session. A replacement launched from a session's shell must not inherit
 * them: CODEX_HOME, for example, would make the new Conductor treat one
 * session's isolated home as the shared Codex home.
 */
const SESSION_SCOPED_NAMES = new Set([
  'AI_AGENT',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDECODE',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CONDUCTOR_CONSOLE_TTY',
  'IS_DEMO',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'TMUX',
  'TMUX_PANE',
  OWNER_PID_ENV,
  OWNER_START_ENV,
]);
const SESSION_SCOPED_PREFIXES = ['CLAUDE_CODE_', 'CODEX_'];

/** The environment for a replacement Conductor: the caller's, minus session-scoped values, plus console ownership. */
export function replacementEnvironment(env: NodeJS.ProcessEnv, host: ConductorHost): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (SESSION_SCOPED_NAMES.has(name) || SESSION_SCOPED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    result[name] = value;
  }
  if (host.kind === 'console') {
    // Panes keep opening in the console's window, and the replacement stops when that console closes.
    if (host.consoleTty !== undefined) result.CONDUCTOR_CONSOLE_TTY = host.consoleTty;
    result[OWNER_PID_ENV] = String(host.consolePid);
    if (host.consoleStartToken !== undefined) result[OWNER_START_ENV] = host.consoleStartToken;
  }
  return result;
}

function describeBuild(identity: HealthIdentity | undefined): string {
  if (identity?.version === undefined) return 'unknown build';
  return buildIdentity(identity.version, identity.build ?? undefined);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Replace this fleet's Conductor and wait until the new process owns the fleet
 * lock and answers /health. /health answers only after startup has re-adopted
 * surviving panes and reconciled session state.
 */
export async function restartConductor(options: RestartOptions, deps: RestartDependencies): Promise<RestartResult> {
  const started = deps.now();
  const oldPid = deps.lockOwner();
  const oldHealth = oldPid === undefined ? undefined : await deps.health();
  const host: ConductorHost = oldPid === undefined ? { kind: 'none' } : await deps.detectHost(oldPid);

  let replacement: SpawnedReplacement | undefined;
  if (host.kind === 'service') {
    await deps.restartService(host);
  } else {
    if (oldPid !== undefined) await deps.stop();
    replacement = deps.spawnReplacement(replacementEnvironment(deps.env, host));
  }

  const deadline = started + (options.timeoutMs ?? RESTART_TIMEOUT_MS);
  for (;;) {
    const pid = deps.lockOwner();
    if (pid !== undefined && pid !== oldPid) {
      const health = await deps.health();
      if (health !== undefined && (health.pid === undefined || health.pid === pid)) {
        return {
          ok: true,
          message: successMessage(options, host, oldPid, oldHealth, pid, health, deps.now() - started),
        };
      }
    }
    if (replacement?.exited() === true || deps.now() >= deadline) {
      const reason =
        replacement?.exited() === true
          ? 'exited during startup'
          : `did not report healthy within ${seconds(deps.now() - started)}`;
      return {
        ok: false,
        message: `The replacement Conductor for ${options.fleetLabel} ${reason}. Session panes were left running. See ${options.logPath}, then recover with: ${options.recoveryHint}`,
      };
    }
    await deps.sleep(RESTART_POLL_MS);
  }
}

function successMessage(
  options: RestartOptions,
  host: ConductorHost,
  oldPid: number | undefined,
  oldHealth: HealthIdentity | undefined,
  newPid: number,
  newHealth: HealthIdentity,
  elapsedMs: number,
): string {
  if (host.kind === 'none') {
    return `No Conductor was running for ${options.fleetLabel}; started pid ${String(newPid)} (${describeBuild(newHealth)}) in ${seconds(elapsedMs)}, running detached (log: ${options.logPath}).`;
  }
  const head = `Restarted ${options.fleetLabel} Conductor: pid ${String(oldPid)} → ${String(newPid)}, ${describeBuild(oldHealth)} → ${describeBuild(newHealth)}, in ${seconds(elapsedMs)}. Session panes kept running`;
  switch (host.kind) {
    case 'service':
      return `${head}; restarted through ${host.manager} (${host.name}).`;
    case 'console':
      return `${head}; the operator console (pid ${String(host.consolePid)}${host.consoleTty === undefined ? '' : `, ${host.consoleTty}`}) stays attached, and the new Conductor stops when that console closes.`;
    case 'foreground':
      return `${head}; the replacement runs detached (log: ${options.logPath}).`;
  }
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 15_000 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${file} ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

async function servicePid(fleetDir: string, instance: string | undefined): Promise<ConductorHost | undefined> {
  try {
    if (platform() === 'darwin') {
      if (!existsSync(launchdPlistPath(fleetDir, instance))) return undefined;
      const label = launchdLabel(fleetDir, instance);
      const pid = /"PID"\s*=\s*(\d+);/u.exec(await execFileText('launchctl', ['list', label]))?.[1];
      return pid === undefined ? undefined : { kind: 'service', manager: 'launchd', name: label, pid: Number(pid) };
    }
    if (!existsSync(systemdUnitPath(fleetDir, instance))) return undefined;
    const unit = systemdUnit(fleetDir, instance);
    const pid = Number.parseInt(
      (await execFileText('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit])).trim(),
      10,
    );
    return pid > 0 ? { kind: 'service', manager: 'systemd', name: unit, pid } : undefined;
  } catch {
    return undefined;
  }
}

/** Classify the lock owner by its service manager or parent process. */
export async function detectConductorHost(
  fleetDir: string,
  instance: string | undefined,
  pid: number,
): Promise<ConductorHost> {
  const service = await servicePid(fleetDir, instance);
  if (service?.kind === 'service' && service.pid === pid) return service;
  const consolePid = parentPid(pid);
  if (consolePid !== undefined && processMatchesFleetConsole(consolePid, fleetDir)) {
    const consoleTty = processTty(consolePid);
    const consoleStartToken = processStartToken(consolePid);
    return {
      kind: 'console',
      pid,
      consolePid,
      ...(consoleTty === undefined ? {} : { consoleTty }),
      ...(consoleStartToken === undefined ? {} : { consoleStartToken }),
    };
  }
  return { kind: 'foreground', pid };
}

export interface DefaultRestartDependencyOptions {
  fleetDir: string;
  instance: string | undefined;
  lockPath: string;
  healthUrl: string;
  logPath: string;
  /** Arguments after the executable that launch `start --foreground` for this fleet. */
  launchArgs: string[];
}

export function defaultRestartDependencies(options: DefaultRestartDependencyOptions): RestartDependencies {
  return {
    lockOwner: () => {
      const owner = readFleetLock(options.lockPath);
      return owner !== undefined && isProcessAlive(owner.pid) ? owner.pid : undefined;
    },
    health: async () => {
      try {
        const response = await fetch(options.healthUrl, { signal: AbortSignal.timeout(1_000) });
        if (!response.ok) return undefined;
        const payload = (await response.json()) as Record<string, unknown>;
        return {
          ...(typeof payload.pid === 'number' ? { pid: payload.pid } : {}),
          ...(typeof payload.version === 'string' ? { version: payload.version } : {}),
          ...(typeof payload.build === 'string' ? { build: payload.build } : {}),
        };
      } catch {
        return undefined;
      }
    },
    detectHost: (pid) => detectConductorHost(options.fleetDir, options.instance, pid),
    restartService: async (host) => {
      if (host.manager === 'launchd') {
        await execFileText('launchctl', ['kickstart', '-k', `gui/${String(userInfo().uid)}/${host.name}`]);
      } else {
        await execFileText('systemctl', ['--user', 'restart', host.name]);
      }
    },
    stop: async () => {
      await killFleetConductor(options.fleetDir, options.lockPath);
    },
    spawnReplacement: (env) => {
      const out = openSync(options.logPath, 'a');
      // Detached into its own session so it outlives the caller's shell, even
      // when that shell belongs to a session this Conductor manages.
      const child = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1] ?? 'conductor', ...options.launchArgs],
        {
          detached: true,
          stdio: ['ignore', out, out],
          env,
        },
      );
      child.unref();
      return { pid: child.pid, exited: () => child.exitCode !== null || child.signalCode !== null };
    },
    env: process.env,
    now: Date.now,
    sleep: (ms) => sleep(ms),
  };
}
