import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  processLooksLikeShepherd,
  processMatchesShepherd,
  readRuntimeStatus,
  ShepherdRuntimeReporter,
  ShepherdServiceLock,
} from '../src/shepherd/runtime.js';

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

describe('PR Shepherd runtime coordination', () => {
  it('writes an owner-only atomic heartbeat correlated to launch token and pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-runtime-'));
    const database = join(dir, 'data', 'shepherd.db');
    mkdirSync(join(dir, 'data'), { recursive: true });
    try {
      const reporter = new ShepherdRuntimeReporter(database, join(dir, 'profile.yaml'), 'token', 123);
      reporter.pollStarted();
      reporter.pollSucceeded();
      expect(readRuntimeStatus(`${database}.runtime-status.json`)).toMatchObject({
        pid: 123,
        launchToken: 'token',
        state: 'healthy',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prevents concurrent acquisition by the same live owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-lock-'));
    const path = join(dir, 'shepherd.lock');
    const profile = join(dir, 'profile.yaml');
    const first = new ShepherdServiceLock(path, profile, process.pid, 'first');
    const second = new ShepherdServiceLock(path, profile, process.pid, 'second', () => true);
    try {
      first.acquire();
      expect(() => second.acquire()).toThrow('already running');
    } finally {
      first.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'default discovery', args: ['start'] },
    { name: 'relative config', args: ['start', '-c', './relative.yaml'] },
  ])('conservatively blocks a real shepherd-like owner using $name', async ({ args }) => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-real-process-'));
    const script = join(dir, 'pr-shepherd-fixture.mjs');
    const path = join(dir, 'shepherd.lock');
    const profile = join(dir, 'profile.yaml');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, [script, ...args], { cwd: dir, stdio: 'ignore' });
    try {
      await once(child, 'spawn');
      if (child.pid === undefined) throw new Error('Fixture process did not receive a pid.');
      expect(processLooksLikeShepherd(child.pid)).toBe(true);
      writeFileSync(path, JSON.stringify({ pid: child.pid, launchToken: 'live-owner', configPath: profile }));
      const contender = new ShepherdServiceLock(path, profile, process.pid, 'contender');
      expect(() => contender.acquire()).toThrow('already running');
    } finally {
      await stopChild(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires an absolute profile match before manager-style process signaling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-real-process-'));
    const script = join(dir, 'pr-shepherd-fixture.mjs');
    const profile = join(dir, 'profile.yaml');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, [script, 'start', '--config', profile], { cwd: dir, stdio: 'ignore' });
    try {
      await once(child, 'spawn');
      if (child.pid === undefined) throw new Error('Fixture process did not receive a pid.');
      expect(processMatchesShepherd(child.pid, profile)).toBe(true);
      expect(processMatchesShepherd(child.pid, join(dir, 'other.yaml'))).toBe(false);
    } finally {
      await stopChild(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a crashed owner lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-lock-'));
    const path = join(dir, 'shepherd.lock');
    const profile = join(dir, 'profile.yaml');
    writeFileSync(path, JSON.stringify({ pid: 999_999_999, launchToken: 'old', configPath: profile }));
    const lock = new ShepherdServiceLock(path, profile, process.pid, 'new');
    try {
      lock.acquire();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid, launchToken: 'new' });
    } finally {
      lock.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a recycled live PID that is not a matching Shepherd process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-lock-'));
    const path = join(dir, 'shepherd.lock');
    const profile = join(dir, 'profile.yaml');
    writeFileSync(path, JSON.stringify({ pid: process.pid, launchToken: 'old', configPath: profile }));
    const lock = new ShepherdServiceLock(path, profile, process.pid, 'new', () => false);
    try {
      lock.acquire();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ launchToken: 'new' });
    } finally {
      lock.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reclaim a fresh owner that replaces a stale lock during recovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-lock-'));
    const path = join(dir, 'shepherd.lock');
    const profile = join(dir, 'profile.yaml');
    writeFileSync(path, JSON.stringify({ pid: 999_999_999, launchToken: 'stale', configPath: profile }));
    let checks = 0;
    const contender = new ShepherdServiceLock(path, profile, process.pid, 'contender', () => {
      checks += 1;
      if (checks === 1) {
        writeFileSync(path, JSON.stringify({ pid: process.pid, launchToken: 'winner', configPath: profile }));
        return false;
      }
      return true;
    });
    try {
      expect(() => contender.acquire()).toThrow('already running');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ launchToken: 'winner' });
    } finally {
      contender.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not remove a lock that was replaced after acquisition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-lock-'));
    const path = join(dir, 'shepherd.lock');
    const profile = join(dir, 'profile.yaml');
    const lock = new ShepherdServiceLock(path, profile, process.pid, 'ours');
    try {
      lock.acquire();
      writeFileSync(path, JSON.stringify({ pid: process.pid, launchToken: 'replacement', configPath: profile }));
      lock.release();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ launchToken: 'replacement' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to poll after another owner replaces its lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-lock-'));
    const path = join(dir, 'shepherd.lock');
    const profile = join(dir, 'profile.yaml');
    const lock = new ShepherdServiceLock(path, profile, process.pid, 'ours');
    try {
      lock.acquire();
      writeFileSync(path, JSON.stringify({ pid: process.pid, launchToken: 'replacement', configPath: profile }));
      expect(() => lock.assertOwned()).toThrow('refusing to poll');
    } finally {
      lock.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
