import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPreflight,
  preflightFailures,
  runPreflight,
  stableConductorExecutable,
  supportedNode,
  type PreflightDependencies,
} from '../src/cli/doctor.js';
import { ensureFleetScaffold } from '../src/cli/scaffold.js';
import { eventJournalDegradedPath } from '../src/events/journal.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-doctor-'));
  ensureFleetScaffold(baseDir);
  writeFileSync(
    join(baseDir, '.conductor', 'config', 'supervisor.yaml'),
    'terminal:\n  backend: tmux\nruntimes:\n  claudeCode:\n    binary: claude\n',
  );
});

afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

function dependencies(overrides: Partial<PreflightDependencies> = {}): Partial<PreflightDependencies> {
  return {
    nodeVersion: '22.13.0',
    platform: 'linux',
    executablePath: '/opt/agent-conductor/dist/cli/index.js',
    command: (name) => ({
      ok: ['claude', 'codex', 'git', 'curl', 'tmux', 'gh'].includes(name),
      stdout: name === 'tmux' ? 'tmux 3.4' : `${name} test`,
    }),
    writable: () => true,
    portState: async () => 'available',
    ...overrides,
  };
}

describe('conductor doctor', () => {
  it('implements the package Node engine boundary', () => {
    expect(supportedNode('22.12.0')).toBe(false);
    expect(supportedNode('22.13.0')).toBe(true);
    expect(supportedNode('23.3.0')).toBe(false);
    expect(supportedNode('23.4.0')).toBe(true);
    expect(supportedNode('24.0.0')).toBe(true);
    expect(stableConductorExecutable('/opt/agent-conductor/dist/cli/index.js')).toBe(true);
    expect(stableConductorExecutable('/workspace/src/cli/index.ts')).toBe(false);
    expect(stableConductorExecutable('/workspace/.pnpm/agent-conductor/dist/cli/index.js')).toBe(false);
  });

  it('passes a valid fleet and formats compact diagnostic rows', async () => {
    const results = await runPreflight(baseDir, dependencies());
    expect(preflightFailures(results)).toEqual([]);
    expect(formatPreflight(results)).toContain('✓ Fleet config:');
    expect(formatPreflight(results)).toContain('✓ tmux backend: tmux 3.4');
    expect(formatPreflight(results)).toContain('✓ Event journal: enabled; no recorded write failures');
  });

  it('reports a healthy iTerm backend without a recurring first-use permission warning', async () => {
    writeFileSync(
      join(baseDir, '.conductor', 'config', 'supervisor.yaml'),
      'terminal:\n  backend: iterm\nruntimes:\n  claudeCode:\n    binary: claude\n',
    );
    const results = await runPreflight(
      baseDir,
      dependencies({
        platform: 'darwin',
        command: (name) => ({
          ok: ['claude', 'codex', 'git', 'curl', 'osascript', 'open'].includes(name),
          stdout: `${name} test`,
        }),
      }),
    );

    expect(results).toContainEqual({
      level: 'pass',
      label: 'iTerm backend',
      detail: 'iTerm2 and AppleScript are available',
    });
    expect(results.some((item) => item.label === 'iTerm automation')).toBe(false);
  });

  it('warns when a previous journal write failure made the exported history incomplete', async () => {
    const dataDir = join(baseDir, '.conductor', 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(eventJournalDegradedPath(dataDir), '{}\n');
    const results = await runPreflight(baseDir, dependencies());
    const journal = results.find((item) => item.label === 'Event journal');
    expect(journal).toMatchObject({ level: 'warn' });
    expect(journal?.detail).not.toContain('{}');
    expect(journal?.detail).toContain(eventJournalDegradedPath(dataDir));
    expect(journal?.detail).toContain('remove');
  });

  it('reports unsupported Node and malformed config as blockers', async () => {
    writeFileSync(join(baseDir, '.conductor', 'config', 'supervisor.yaml'), 'mcp:\n  port: nope\n');
    const results = await runPreflight(baseDir, dependencies({ nodeVersion: '22.12.0' }));
    expect(preflightFailures(results).map((item) => item.label)).toEqual(['Node.js', 'Fleet config']);
  });

  it('blocks unwritable fleet paths and a missing selected runtime', async () => {
    const results = await runPreflight(
      baseDir,
      dependencies({
        writable: () => false,
        command: (name) => ({ ok: name !== 'claude', stdout: name === 'tmux' ? 'tmux 3.4' : '' }),
      }),
    );
    expect(preflightFailures(results).map((item) => item.label)).toEqual(
      expect.arrayContaining(['Config directory', 'Data directory', 'claude-code runtime']),
    );
  });

  it('blocks an unavailable selected backend and occupied fleet port', async () => {
    const results = await runPreflight(
      baseDir,
      dependencies({
        command: (name) => ({ ok: name !== 'tmux', stdout: '' }),
        portState: async () => 'occupied',
      }),
    );
    expect(preflightFailures(results).map((item) => item.label)).toEqual(
      expect.arrayContaining(['tmux backend', 'Fleet port']),
    );
  });

  it('blocks enabled PR Shepherd until gh auth and the identity profile are ready', async () => {
    writeFileSync(
      join(baseDir, '.conductor', 'config', 'supervisor.yaml'),
      'terminal:\n  backend: tmux\nshepherd:\n  enabled: true\n',
    );
    const results = await runPreflight(
      baseDir,
      dependencies({ command: (name) => ({ ok: name !== 'gh', stdout: name === 'tmux' ? 'tmux 3.4' : '' }) }),
    );
    expect(preflightFailures(results).map((item) => item.label)).toEqual(
      expect.arrayContaining(['GitHub CLI', 'PR Shepherd profile']),
    );
  });
});
