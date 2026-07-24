import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ShepherdManager,
  type ShepherdProcessControl,
  type ShepherdProcessSpawner,
} from '../src/core/shepherd-manager.js';
import { ShepherdRuntimeReporter } from '../src/shepherd/runtime.js';

function profile(dir: string): { configPath: string; databasePath: string } {
  const configPath = join(dir, 'config', 'pr-shepherd.yaml');
  const databasePath = join(dir, 'data', 'shepherd.db');
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(
    configPath,
    `version: 2\nprofile:\n  githubUser: octocat\npolling:\n  intervalSeconds: 10\ndatabasePath: ../data/shepherd.db\n`,
  );
  return { configPath, databasePath };
}

function fakeChild(pid = 4242): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
    kill(signal?: NodeJS.Signals) {
      Object.assign(child, { signalCode: signal ?? 'SIGTERM' });
      queueMicrotask(() => child.emit('exit', null, signal ?? 'SIGTERM'));
      return true;
    },
  });
  return child;
}

describe('managed PR Shepherd lifecycle', () => {
  it('reports panel unsupported without spawning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-manager-'));
    const paths = profile(dir);
    let spawned = false;
    const spawner: ShepherdProcessSpawner = { spawn: () => ((spawned = true), fakeChild()) };
    try {
      const manager = new ShepherdManager(
        { enabled: true, presentation: 'panel', configPath: paths.configPath },
        spawner,
      );
      await manager.start();
      expect(manager.status().state).toBe('panel-unsupported');
      expect(spawned).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('becomes healthy only after a matching heartbeat and stops its child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-manager-'));
    const paths = profile(dir);
    let child: ChildProcess | undefined;
    let token = '';
    const spawner: ShepherdProcessSpawner = {
      spawn: (_entry, _args, env) => {
        token = env.PR_SHEPHERD_LAUNCH_TOKEN ?? '';
        child = fakeChild();
        return child;
      },
    };
    try {
      const manager = new ShepherdManager(
        { enabled: true, presentation: 'headless', configPath: paths.configPath },
        spawner,
      );
      await manager.start();
      expect(manager.status().state).toBe('starting');
      const reporter = new ShepherdRuntimeReporter(paths.databasePath, paths.configPath, token, 4242);
      reporter.pollStarted();
      reporter.pollSucceeded();
      expect(manager.status().state).toBe('healthy');
      await manager.stop();
      expect(manager.status().state).toBe('stopped');
      expect(child?.signalCode).toBe('SIGTERM');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets its stopping lifecycle and waits for termination before a later start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-manager-'));
    const paths = profile(dir);
    let spawns = 0;
    let exits = 0;
    const spawner: ShepherdProcessSpawner = {
      spawn: () => {
        spawns += 1;
        const child = fakeChild(4200 + spawns);
        child.once('exit', () => {
          exits += 1;
        });
        return child;
      },
    };
    try {
      const manager = new ShepherdManager(
        { enabled: true, presentation: 'headless', configPath: paths.configPath },
        spawner,
      );
      await manager.start();
      await manager.stop();
      expect(exits).toBe(1);
      await manager.start();
      expect(spawns).toBe(2);
      expect(manager.status().state).toBe('starting');
      await manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a deleted managed profile to actionable config-invalid status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-manager-'));
    const configPath = join(dir, 'config', 'pr-shepherd.yaml');
    const manager = new ShepherdManager({ enabled: true, presentation: 'headless', configPath });
    try {
      await manager.start();
      const status = manager.status();
      expect(status.state).toBe('config-invalid');
      expect(status.detail).toContain('pr-shepherd init -C <fleetDir> or conductor start');
    } finally {
      await manager.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isolates spawn errors and reaches failed after a crash loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-manager-'));
    const paths = profile(dir);
    const children: ChildProcess[] = [];
    const spawner: ShepherdProcessSpawner = {
      spawn: () => {
        const child = fakeChild(5000 + children.length);
        children.push(child);
        queueMicrotask(() => child.emit('error', new Error('spawn failed')));
        return child;
      },
    };
    try {
      const manager = new ShepherdManager(
        { enabled: true, presentation: 'headless', configPath: paths.configPath },
        spawner,
      );
      await manager.start();
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      expect(manager.status().state).toBe('failed');
      await manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);

  it('isolates a synchronous spawn failure as stale diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-manager-'));
    const paths = profile(dir);
    const spawner: ShepherdProcessSpawner = {
      spawn: () => {
        throw new Error('runtime executable missing');
      },
    };
    try {
      const manager = new ShepherdManager(
        { enabled: true, presentation: 'headless', configPath: paths.configPath },
        spawner,
      );
      await manager.start();
      const status = manager.status();
      expect(status.state).toBe('stale');
      expect(status.detail).toContain('runtime executable missing');
      await manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { matching: true, expectedSignals: ['SIGTERM'] },
    { matching: false, expectedSignals: [] },
  ])(
    'reconciles a prior process without killing unrelated PID reuse ($matching)',
    async ({ matching, expectedSignals }) => {
      const dir = mkdtempSync(join(tmpdir(), 'shepherd-manager-'));
      const paths = profile(dir);
      const old = new ShepherdRuntimeReporter(paths.databasePath, paths.configPath, 'old-token', 1111);
      old.pollStarted();
      old.pollSucceeded();
      const signals: string[] = [];
      let oldAlive = true;
      const control: ShepherdProcessControl = {
        isAlive: (pid) => pid === 1111 && oldAlive,
        matches: () => matching,
        signal: (_pid, signal) => {
          signals.push(signal);
          oldAlive = false;
        },
      };
      let spawned = false;
      const spawner: ShepherdProcessSpawner = {
        spawn: () => {
          spawned = true;
          return fakeChild();
        },
      };
      try {
        const manager = new ShepherdManager(
          { enabled: true, presentation: 'headless', configPath: paths.configPath },
          spawner,
          control,
        );
        await manager.start();
        expect(spawned).toBe(true);
        expect(signals).toEqual(expectedSignals);
        await manager.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
