import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupervisorConfig } from '../config/schema.js';
import { assertShepherdProfileReady, loadShepherdConfig } from '../shepherd/config.js';
import { processIsAlive, processMatchesShepherd, readRuntimeStatus, runtimeStatusPath } from '../shepherd/runtime.js';

const STARTUP_GRACE_MS = 60_000;
const CRASH_WINDOW_MS = 10_000;
const MAX_RESTARTS = 3;
const STOP_TIMEOUT_MS = 5_000;
const STDERR_LIMIT = 2_000;

export type ManagedShepherdState =
  | 'disabled'
  | 'config-invalid'
  | 'panel-unsupported'
  | 'paused'
  | 'starting'
  | 'healthy'
  | 'stale'
  | 'restarting'
  | 'failed'
  | 'stopped';

export interface ManagedShepherdStatus {
  state: ManagedShepherdState;
  presentation: 'headless' | 'panel';
  configPath: string;
  pid: number | null;
  lastSuccessAt: string | null;
  detail: string | null;
}

export interface ShepherdProcessSpawner {
  spawn(entrypoint: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess;
}

export interface ShepherdProcessControl {
  isAlive(pid: number): boolean;
  matches(pid: number, configPath: string): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
}

const defaultSpawner: ShepherdProcessSpawner = {
  spawn(entrypoint, args, env) {
    const sourceMode = entrypoint.endsWith('.ts');
    return spawn(process.execPath, [...(sourceMode ? ['--import', 'tsx'] : []), entrypoint, ...args], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  },
};
const defaultProcessControl: ShepherdProcessControl = {
  isAlive: processIsAlive,
  matches: processMatchesShepherd,
  signal(pid, signal) {
    process.kill(pid, signal);
  },
};

/** Owns the optional PR Shepherd companion without coupling it to agent session lifecycle. */
export class ShepherdManager {
  private child: ChildProcess | undefined;
  private launchToken: string | undefined;
  private databasePath: string | undefined;
  private pollingIntervalMs = 180_000;
  private stopping = false;
  private restartCount = 0;
  private launchedAt = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private stderrTail = '';
  private coordinatorSession: string | undefined;
  private statusValue: ManagedShepherdStatus;

  constructor(
    private readonly config: SupervisorConfig['shepherd'],
    private readonly spawner: ShepherdProcessSpawner = defaultSpawner,
    private readonly processControl: ShepherdProcessControl = defaultProcessControl,
  ) {
    this.statusValue = {
      state: config.enabled ? 'stopped' : 'disabled',
      presentation: config.presentation,
      configPath: config.configPath,
      pid: null,
      lastSuccessAt: null,
      detail: null,
    };
  }

  status(): ManagedShepherdStatus {
    this.refreshHealth();
    return { ...this.statusValue };
  }

  /** Validated Conductor-delivery recipient for status decoration. */
  recipientSession(): string | undefined {
    return this.config.enabled ? this.coordinatorSession : undefined;
  }

  async start(isRecipientPaused: (recipient: string) => boolean = () => false): Promise<void> {
    if (!this.config.enabled) return;
    this.stopping = false;
    this.restartCount = 0;
    this.coordinatorSession = undefined;
    if (this.config.presentation === 'panel') {
      this.setStatus('panel-unsupported', 'Panel presentation is not supported by the current terminal backend.');
      return;
    }
    let profile: ReturnType<typeof loadShepherdConfig>;
    try {
      profile = this.validateProfile();
    } catch (error) {
      this.setStatus('config-invalid', this.cleanError(error));
      return;
    }
    this.coordinatorSession = profile.delivery.type === 'conductor' ? profile.delivery.coordinatorSession : undefined;
    this.databasePath = profile.databasePath;
    this.pollingIntervalMs = profile.polling.intervalSeconds * 1000;
    try {
      await this.reconcilePriorProcess();
      if (this.coordinatorSession !== undefined && isRecipientPaused(this.coordinatorSession)) {
        this.stopping = true;
        this.setStatus('paused', null);
        return;
      }
      this.spawnChild();
    } catch (error) {
      this.classifyLaunchFailure(error);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    await this.terminateChild();
    if (this.config.enabled) this.setStatus('stopped', null);
  }

  /** Pause the managed companion without losing its validated delivery recipient. */
  async pause(): Promise<boolean> {
    if (!this.config.enabled || this.statusValue.state === 'paused') return false;
    this.stopping = true;
    this.clearTimers();
    await this.terminateChild();
    this.setStatus('paused', null);
    return true;
  }

  /** Restart a companion that was deliberately paused through its coordinator session. */
  async resume(): Promise<boolean> {
    if (!this.config.enabled || this.statusValue.state !== 'paused') return false;
    await this.start();
    return true;
  }

  private clearTimers(): void {
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer);
    this.restartTimer = undefined;
    this.healthTimer = undefined;
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child?.exitCode === null && child.pid !== undefined) {
      child.kill('SIGTERM');
      if (!(await this.waitForExit(child, STOP_TIMEOUT_MS))) child.kill('SIGKILL');
      await this.waitForExit(child, STOP_TIMEOUT_MS);
    }
  }

  private validateProfile(): ReturnType<typeof loadShepherdConfig> {
    assertShepherdProfileReady(this.config.configPath);
    return loadShepherdConfig(this.config.configPath);
  }

  private async reconcilePriorProcess(): Promise<void> {
    if (this.databasePath === undefined) return;
    const path = runtimeStatusPath(this.databasePath);
    const previous = readRuntimeStatus(path);
    if (previous !== undefined && this.processControl.isAlive(previous.pid)) {
      if (this.processControl.matches(previous.pid, previous.configPath)) {
        this.processControl.signal(previous.pid, 'SIGTERM');
        if (!(await this.waitForPidExit(previous.pid, STOP_TIMEOUT_MS))) {
          this.processControl.signal(previous.pid, 'SIGKILL');
          if (!(await this.waitForPidExit(previous.pid, STOP_TIMEOUT_MS))) {
            throw new Error(`Prior PR Shepherd process ${String(previous.pid)} did not terminate.`);
          }
        }
      }
      // PID reuse/unrelated process is never killed; the stale artifact is still discarded.
    }
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private spawnChild(): void {
    if (this.stopping) return;
    this.validateProfile();
    this.launchToken = randomUUID();
    this.stderrTail = '';
    this.launchedAt = Date.now();
    this.setStatus(this.restartCount === 0 ? 'starting' : 'restarting', null);
    const child = this.spawner.spawn(this.entrypoint(), ['start', '--config', this.config.configPath], {
      ...process.env,
      PR_SHEPHERD_LAUNCH_TOKEN: this.launchToken,
    });
    this.child = child;
    this.statusValue.pid = child.pid ?? null;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_LIMIT);
    });
    child.once('error', (error) => {
      if (this.child === child && !this.stopping) this.handleExit(child, this.cleanError(error));
    });
    child.once('exit', (code, signal) => {
      if (this.child === child && !this.stopping) {
        this.handleExit(child, `exited ${signal ?? `with code ${String(code)}`}`);
      }
    });
    this.healthTimer ??= setInterval(() => this.refreshHealth(), 2_000);
    this.healthTimer.unref();
  }

  private handleExit(child: ChildProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    const detail = this.cleanError(`${reason}${this.stderrTail.length > 0 ? `: ${this.stderrTail}` : ''}`);
    if (Date.now() - this.launchedAt <= CRASH_WINDOW_MS) this.restartCount += 1;
    else this.restartCount = 1;
    if (this.restartCount > MAX_RESTARTS) {
      this.setStatus('failed', `PR Shepherd stopped after ${String(MAX_RESTARTS)} restart attempts: ${detail}`);
      return;
    }
    this.setStatus('restarting', detail);
    const delay = Math.min(8_000, 500 * 2 ** (this.restartCount - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      try {
        this.spawnChild();
      } catch (error) {
        this.classifyLaunchFailure(error);
      }
    }, delay);
    this.restartTimer.unref();
  }

  private refreshHealth(): void {
    const child = this.child;
    if (child?.pid === undefined || this.databasePath === undefined || this.launchToken === undefined) {
      return;
    }
    const runtime = readRuntimeStatus(runtimeStatusPath(this.databasePath));
    if (runtime?.pid !== child.pid || runtime.launchToken !== this.launchToken) {
      if (Date.now() - this.launchedAt > STARTUP_GRACE_MS)
        this.setStatus('stale', 'No matching PR Shepherd heartbeat.');
      return;
    }
    const anchor = runtime.lastSuccessAt ?? runtime.lastPollStartedAt ?? runtime.startedAt;
    const staleAfter = Math.max(60_000, this.pollingIntervalMs * 3);
    if (Date.now() - Date.parse(anchor) > staleAfter) {
      this.setStatus('stale', `Last PR Shepherd heartbeat was ${anchor}.`);
      return;
    }
    if (runtime.state === 'healthy') {
      this.statusValue = {
        ...this.statusValue,
        state: 'healthy',
        pid: child.pid,
        lastSuccessAt: runtime.lastSuccessAt ?? null,
        detail: null,
      };
    } else if (runtime.state === 'failed') {
      this.setStatus('stale', runtime.error ?? 'The latest PR Shepherd poll failed.');
    }
  }

  private entrypoint(): string {
    const compiled = fileURLToPath(new URL('../shepherd/cli.js', import.meta.url));
    return existsSync(compiled) ? compiled : compiled.replace(/\.js$/, '.ts');
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.processControl.isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !this.processControl.isAlive(pid);
  }

  private setStatus(state: ManagedShepherdState, detail: string | null): void {
    this.statusValue = {
      ...this.statusValue,
      state,
      pid: this.child?.pid ?? null,
      detail,
    };
  }

  private classifyLaunchFailure(error: unknown): void {
    try {
      this.validateProfile();
      this.setStatus('stale', this.cleanError(error));
    } catch (profileError) {
      this.setStatus('config-invalid', this.cleanError(profileError));
    }
  }

  private cleanError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
  }
}
