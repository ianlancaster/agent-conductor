import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { killFleetConductor } from '../src/cli/kill.js';
import { ensureFleetScaffold } from '../src/cli/scaffold.js';

let fleetDir: string;
let lockPath: string;

function writeLock(pid: number, fleet = fleetDir): void {
  writeFileSync(
    lockPath,
    JSON.stringify({ pid, startedAt: '2026-07-27T00:00:00.000Z', ...(fleet.length > 0 ? { fleetDir: fleet } : {}) }),
  );
}

beforeEach(() => {
  fleetDir = mkdtempSync(join(tmpdir(), 'conductor-kill-'));
  lockPath = join(fleetDir, 'conductor.lock');
});

afterEach(() => {
  rmSync(fleetDir, { recursive: true, force: true });
});

describe('killFleetConductor', () => {
  it('is idempotent when no fleet lock exists', async () => {
    await expect(killFleetConductor(fleetDir, lockPath)).resolves.toMatchObject({ outcome: 'not-running' });
  });

  it('clears a stale lock without signaling its dead pid', async () => {
    writeLock(4242);
    const signal = vi.fn();

    await expect(killFleetConductor(fleetDir, lockPath, { isAlive: () => false, signal })).resolves.toMatchObject({
      outcome: 'stale-lock-cleared',
    });
    expect(signal).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('terminates a matching fleet process gracefully', async () => {
    writeLock(4242);
    const signal = vi.fn();

    await expect(
      killFleetConductor(fleetDir, lockPath, {
        isAlive: () => true,
        matchesFleet: () => true,
        signal,
        waitForExit: async () => true,
      }),
    ).resolves.toMatchObject({ outcome: 'terminated' });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('escalates an unresponsive matching process to SIGKILL', async () => {
    writeLock(4242);
    const signal = vi.fn();
    const waitForExit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      killFleetConductor(fleetDir, lockPath, {
        isAlive: () => true,
        matchesFleet: () => true,
        signal,
        waitForExit,
      }),
    ).resolves.toMatchObject({ outcome: 'killed' });
    expect(signal.mock.calls).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL'],
    ]);
  });

  it('refuses a live recycled pid that does not look like this fleet conductor', async () => {
    writeLock(4242);
    const signal = vi.fn();

    await expect(
      killFleetConductor(fleetDir, lockPath, {
        isAlive: () => true,
        matchesFleet: () => false,
        signal,
      }),
    ).rejects.toThrow('does not match this fleet');
    expect(signal).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('uses the recorded process birth identity to reject pid reuse', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 4242,
        startedAt: '2026-07-27T00:00:00.000Z',
        fleetDir,
        processStartToken: 'original-process',
      }),
    );
    const signal = vi.fn();

    await expect(
      killFleetConductor(fleetDir, lockPath, {
        isAlive: () => true,
        matchesFleet: () => true,
        startToken: () => 'reused-process',
        signal,
      }),
    ).rejects.toThrow('does not match this fleet');
    expect(signal).not.toHaveBeenCalled();
  });

  it('refuses a lock that records another fleet directory', async () => {
    writeLock(4242, join(fleetDir, 'other'));
    const signal = vi.fn();

    await expect(killFleetConductor(fleetDir, lockPath, { isAlive: () => true, signal })).rejects.toThrow(
      'the fleet lock belongs to',
    );
    expect(signal).not.toHaveBeenCalled();
  });

  it('does not remove a replacement lock written during shutdown', async () => {
    writeLock(4242);
    const signal = vi.fn();

    await killFleetConductor(fleetDir, lockPath, {
      isAlive: () => true,
      matchesFleet: () => true,
      signal,
      waitForExit: async () => {
        writeLock(5252);
        return true;
      },
    });

    expect((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }).pid).toBe(5252);
  });

  it('refuses a corrupt ownership record rather than guessing a process', async () => {
    writeFileSync(lockPath, '{not-json');
    await expect(killFleetConductor(fleetDir, lockPath)).rejects.toThrow('Cannot safely identify');
    expect(existsSync(lockPath)).toBe(true);
  });
});

function collectProcess(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout, stderr })));
}

describe('conductor kill CLI', () => {
  it('terminates the process recorded by the current fleet lock', async () => {
    ensureFleetScaffold(fleetDir);
    const dataDir = join(fleetDir, '.conductor', 'data');
    const cliLockPath = join(dataDir, 'conductor.lock');
    const fixturePath = join(fleetDir, 'conductor-fixture.mjs');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(fixturePath, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n");
    const conductor = spawn(process.execPath, [fixturePath, 'start', '--foreground'], {
      cwd: fleetDir,
      stdio: 'ignore',
    });
    if (conductor.pid === undefined) throw new Error('fixture did not receive a pid');
    writeFileSync(cliLockPath, JSON.stringify({ pid: conductor.pid, startedAt: new Date().toISOString(), fleetDir }));

    try {
      const kill = spawn(
        process.execPath,
        ['--import', 'tsx', join(process.cwd(), 'src', 'cli', 'index.ts'), '-C', fleetDir, 'kill'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const result = await collectProcess(kill);
      await new Promise<void>((resolve) => {
        if (conductor.exitCode !== null || conductor.signalCode !== null) resolve();
        else conductor.once('exit', () => resolve());
      });

      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toContain("Stopped this fleet's Conductor");
      expect(existsSync(cliLockPath)).toBe(false);
    } finally {
      if (conductor.exitCode === null && conductor.signalCode === null) conductor.kill('SIGKILL');
    }
  });
});
