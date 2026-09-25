import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinCommandLine, withCmdPassthrough } from '../src/cli/argv.js';
import {
  clearOwnerRecord,
  readOwnerRecord,
  takeOwnerFromEnvironment,
  watchOwner,
  writeOwnerRecord,
} from '../src/cli/owner-watch.js';
import {
  replacementEnvironment,
  restartConductor,
  type ConductorHost,
  type HealthIdentity,
  type RestartDependencies,
} from '../src/cli/restart.js';
import { isProcessAlive, readFleetLock } from '../src/core/lock.js';

const CLI = ['--import', 'tsx', join(process.cwd(), 'src', 'cli', 'index.ts')];

interface FakeFleet {
  deps: RestartDependencies;
  calls: string[];
  spawnedEnv: NodeJS.ProcessEnv[];
}

/** A scripted fleet: `owners` is the lock owner over time; health follows the owner unless overridden. */
function fakeFleet(options: {
  host: ConductorHost;
  owners: (number | undefined)[];
  builds?: Record<number, string>;
  healthPid?: (owner: number) => number | undefined;
  replacementExits?: boolean;
  env?: NodeJS.ProcessEnv;
}): FakeFleet {
  const calls: string[] = [];
  const spawnedEnv: NodeJS.ProcessEnv[] = [];
  let tick = 0;
  let clock = 0;
  const owner = (): number | undefined => options.owners[Math.min(tick, options.owners.length - 1)];
  const deps: RestartDependencies = {
    lockOwner: () => owner(),
    health: async (): Promise<HealthIdentity | undefined> => {
      const pid = owner();
      if (pid === undefined) return undefined;
      return { pid: options.healthPid?.(pid) ?? pid, version: '0.1.0', build: options.builds?.[pid] ?? null };
    },
    detectHost: async () => options.host,
    restartService: async () => {
      calls.push('restart-service');
    },
    stop: async () => {
      calls.push('stop');
    },
    spawnReplacement: (env) => {
      calls.push('spawn');
      spawnedEnv.push(env);
      return { pid: 200, exited: () => options.replacementExits === true };
    },
    env: options.env ?? {},
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      tick += 1;
    },
  };
  return { deps, calls, spawnedEnv };
}

const OPTIONS = {
  fleetLabel: 'fleet-x',
  logPath: '/fleet/data/conductor.out.log',
  recoveryHint: 'conductor -C /fleet restart',
};

describe('restartConductor', () => {
  it('stops a bare foreground Conductor, starts a detached replacement, and reports both builds', async () => {
    const fleet = fakeFleet({
      host: { kind: 'foreground', pid: 100 },
      owners: [100, undefined, 200],
      builds: { 100: 'aaaaaaa', 200: 'bbbbbbb' },
    });
    const result = await restartConductor(OPTIONS, fleet.deps);
    expect(result.ok).toBe(true);
    expect(fleet.calls).toEqual(['stop', 'spawn']);
    expect(result.message).toContain('pid 100 → 200');
    expect(result.message).toContain('0.1.0 (aaaaaaa) → 0.1.0 (bbbbbbb)');
    expect(result.message).toContain('runs detached (log: /fleet/data/conductor.out.log)');
    expect(result.message.split('\n')).toHaveLength(1);
  });

  it('hands console ownership and its terminal to the replacement', async () => {
    const fleet = fakeFleet({
      host: { kind: 'console', pid: 100, consolePid: 42, consoleTty: '/dev/ttys009', consoleStartToken: 'T42' },
      owners: [100, 200],
    });
    const result = await restartConductor(OPTIONS, fleet.deps);
    expect(result.ok).toBe(true);
    expect(fleet.spawnedEnv[0]).toMatchObject({
      CONDUCTOR_CONSOLE_TTY: '/dev/ttys009',
      CONDUCTOR_OWNER_PID: '42',
      CONDUCTOR_OWNER_START: 'T42',
    });
    expect(result.message).toContain('operator console (pid 42, /dev/ttys009) stays attached');
  });

  it('restarts through the service manager without stopping or spawning itself', async () => {
    const fleet = fakeFleet({
      host: { kind: 'service', manager: 'launchd', name: 'com.agent-conductor.x', pid: 100 },
      owners: [100, 100, 300],
    });
    const result = await restartConductor(OPTIONS, fleet.deps);
    expect(fleet.calls).toEqual(['restart-service']);
    expect(result.message).toContain('restarted through launchd (com.agent-conductor.x)');
  });

  it('brings back a fleet whose Conductor is not running', async () => {
    const fleet = fakeFleet({ host: { kind: 'none' }, owners: [undefined, 200] });
    const result = await restartConductor(OPTIONS, fleet.deps);
    expect(fleet.calls).toEqual(['spawn']);
    expect(result.message).toMatch(/^No Conductor was running for fleet-x; started pid 200/u);
  });

  it('waits until /health is served by the new lock owner, not a lingering process', async () => {
    let stale = 2;
    const fleet = fakeFleet({
      host: { kind: 'foreground', pid: 100 },
      owners: [100, 200],
      healthPid: (owner) => (owner === 200 && stale-- > 0 ? 100 : owner),
    });
    const result = await restartConductor(OPTIONS, fleet.deps);
    expect(result.ok).toBe(true);
    expect(stale).toBeLessThan(0);
  });

  it('fails with one recovery line when the replacement exits during startup', async () => {
    const fleet = fakeFleet({
      host: { kind: 'foreground', pid: 100 },
      owners: [100, undefined],
      replacementExits: true,
    });
    const result = await restartConductor(OPTIONS, fleet.deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('exited during startup');
    expect(result.message).toContain('recover with: conductor -C /fleet restart');
    expect(result.message.split('\n')).toHaveLength(1);
  });

  it('fails when no replacement reports healthy before the deadline', async () => {
    const fleet = fakeFleet({ host: { kind: 'foreground', pid: 100 }, owners: [100, undefined] });
    const result = await restartConductor({ ...OPTIONS, timeoutMs: 2_000 }, fleet.deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('did not report healthy within');
  });
});

describe('replacementEnvironment', () => {
  it('drops values a managed session or multiplexer sets, keeping the rest', () => {
    const env = replacementEnvironment(
      {
        PATH: '/bin',
        HOME: '/home/x',
        CODEX_HOME: '/session/codex-home',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'abc',
        CLAUDE_CONFIG_DIR: '/session/claude',
        ANTHROPIC_BASE_URL: 'http://proxy',
        TMUX: '/tmp/tmux,1,0',
        TMUX_PANE: '%3',
        CONDUCTOR_CONSOLE_TTY: '/dev/ttys001',
      },
      { kind: 'foreground', pid: 1 },
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/x' });
  });
});

describe('cmd argument passthrough', () => {
  it('ends option parsing right after cmd, whatever global options precede it', () => {
    expect(withCmdPassthrough(['-C', '/f', 'cmd', '/accept-status', '--session', 'x', 'w1'])).toEqual([
      '-C',
      '/f',
      'cmd',
      '--',
      '/accept-status',
      '--session',
      'x',
      'w1',
    ]);
    expect(withCmdPassthrough(['--instance', 'cmd', 'cmd', '/status'])).toEqual([
      '--instance',
      'cmd',
      'cmd',
      '--',
      '/status',
    ]);
    expect(withCmdPassthrough(['cmd', '--', '/status'])).toEqual(['cmd', '--', '/status']);
    expect(withCmdPassthrough(['status', '--once'])).toEqual(['status', '--once']);
  });

  it('re-quotes a shell-quoted multi-word token but keeps a single whole-line token as is', () => {
    expect(joinCommandLine(['/reject-status', 'w1', 'needs more tests'])).toBe('/reject-status w1 "needs more tests"');
    expect(joinCommandLine(['/reject-status w1 needs more tests'])).toBe('/reject-status w1 needs more tests');
  });
});

describe('owner watch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads and removes the handoff from the environment', () => {
    const env: NodeJS.ProcessEnv = { CONDUCTOR_OWNER_PID: '42', CONDUCTOR_OWNER_START: 'T', KEEP: '1' };
    expect(takeOwnerFromEnvironment(env)).toEqual({ pid: 42, startToken: 'T' });
    expect(env).toEqual({ KEEP: '1' });
    expect(takeOwnerFromEnvironment({ CONDUCTOR_OWNER_PID: 'nope' })).toBeUndefined();
  });

  it('keeps the console handoff for later restarts and clears it only for its own Conductor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-owner-'));
    const path = join(dir, 'conductor.owner.json');
    try {
      writeOwnerRecord(path, { conductorPid: 10, consolePid: 42, consoleStartToken: 'T', consoleTty: '/dev/ttys1' });
      expect(readOwnerRecord(path)).toEqual({
        conductorPid: 10,
        consolePid: 42,
        consoleStartToken: 'T',
        consoleTty: '/dev/ttys1',
      });
      clearOwnerRecord(path, 11);
      expect(readOwnerRecord(path)).toBeDefined();
      clearOwnerRecord(path, 10);
      expect(readOwnerRecord(path)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('calls onGone once when the owner exits or its PID is reused', async () => {
    vi.useFakeTimers();
    for (const answers of [
      ['T', undefined],
      ['T', 'OTHER'],
    ]) {
      const onGone = vi.fn();
      let call = 0;
      watchOwner({ pid: 42, startToken: 'T', onGone, intervalMs: 10, probe: async () => answers[call++] });
      await vi.advanceTimersByTimeAsync(10);
      expect(onGone).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      expect(onGone).toHaveBeenCalledTimes(1);
    }
  });
});

describe('conductor CLI', () => {
  let fleetDir: string;
  let server: Server | undefined;

  beforeEach(() => {
    fleetDir = mkdtempSync(join(tmpdir(), 'conductor-restart-'));
    mkdirSync(join(fleetDir, '.conductor', 'config', 'sessions'), { recursive: true });
  });

  afterEach(async () => {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const lock = readFleetLock(join(fleetDir, '.conductor', 'data', 'conductor.lock'));
    if (lock !== undefined && isProcessAlive(lock.pid)) {
      process.kill(lock.pid, 'SIGTERM');
      // Let the detached replacement finish shutting down before its files are removed.
      const deadline = Date.now() + 10_000;
      while (isProcessAlive(lock.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    rmSync(fleetDir, { recursive: true, force: true });
  });

  function writeSupervisor(port: number, extra = ''): void {
    writeFileSync(
      join(fleetDir, '.conductor', 'config', 'supervisor.yaml'),
      `terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\nruntimes:\n  claudeCode:\n    binary: ${JSON.stringify(process.execPath)}\n  codex:\n    binary: ${JSON.stringify(process.execPath)}\n${extra}`,
    );
  }

  it('passes --session, -r, --help, and a quoted reason through cmd untouched', async () => {
    const received: string[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push((JSON.parse(body) as { command: string }).command);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ reply: 'ok' }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    writeSupervisor((server.address() as AddressInfo).port);

    const run = (args: string[]): Promise<number | null> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [...CLI, '-C', fleetDir, 'cmd', ...args], { stdio: 'ignore' });
        child.on('exit', (code) => resolve(code));
      });
    expect(await run(['/reject-status', '--session', 'x', '-r', '--help', 'w1', 'needs more tests'])).toBe(0);
    expect(await run(['/accept-status --session x w1'])).toBe(0);
    expect(received).toEqual([
      '/reject-status --session x -r --help w1 "needs more tests"',
      '/accept-status --session x w1',
    ]);
  });

  it('refuses to restart before stopping anything when the configuration is invalid', () => {
    writeSupervisor(1, 'notARealKey: true\n');
    const result = spawnSync(process.execPath, [...CLI, '-C', fleetDir, 'restart'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('✗');
    expect(result.stdout).toContain('Restart refused');
  });

  it('replaces a running foreground Conductor with a healthy detached one', async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    writeSupervisor(port);
    const lockPath = join(fleetDir, '.conductor', 'data', 'conductor.lock');
    const original = spawn(process.execPath, [...CLI, '-C', fleetDir, 'start', '--foreground'], {
      env: { ...process.env, TMUX: 'conductor-restart-test' },
      stdio: 'ignore',
    });
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const ok = await fetch(`http://127.0.0.1:${String(port)}/health`)
          .then((response) => response.ok)
          .catch(() => false);
        if (ok) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(readFleetLock(lockPath)?.pid).toBe(original.pid);

      // Asynchronous, so this test process reaps the original child as it exits
      // (a blocked parent would leave a zombie that still answers kill -0).
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [...CLI, '-C', fleetDir, 'restart'], {
          env: { ...process.env, TMUX: 'conductor-restart-test', CODEX_HOME: '/not/the/shared/home' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('exit', (status) => resolve({ status, stdout, stderr }));
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const replacement = readFleetLock(lockPath)?.pid;
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(original.pid);
      expect(result.stdout).toContain(`pid ${String(original.pid)} → ${String(replacement)}`);
      expect(original.exitCode ?? original.signalCode).not.toBeNull();
      const health = (await (await fetch(`http://127.0.0.1:${String(port)}/health`)).json()) as { pid: number };
      expect(health.pid).toBe(replacement);
      expect(readFileSync(join(fleetDir, '.conductor', 'data', 'conductor.out.log'), 'utf8')).toBeDefined();
    } finally {
      if (original.exitCode === null && original.signalCode === null) original.kill('SIGTERM');
    }
  }, 90_000);
});
