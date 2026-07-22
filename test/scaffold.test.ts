import { spawn, spawnSync } from 'node:child_process';
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureFleetScaffold, renderSupervisorConfig } from '../src/cli/scaffold.js';
import { deriveInstanceDefaults } from '../src/config/instance.js';
import { loadSupervisorConfig, validateConfig } from '../src/config/loader.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-scaffold-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('ensureFleetScaffold', () => {
  it('creates a complete, immediately valid hidden fleet scaffold', () => {
    const created = ensureFleetScaffold(baseDir);

    expect(created).toHaveLength(5);
    expect(existsSync(join(baseDir, '.conductor', 'config', 'supervisor.yaml'))).toBe(true);
    expect(existsSync(join(baseDir, '.conductor', 'config', 'sessions'))).toBe(true);
    expect(existsSync(join(baseDir, '.conductor', 'env.template'))).toBe(true);
    expect(existsSync(join(baseDir, '.conductor', '.env'))).toBe(true);
    expect(readFileSync(join(baseDir, '.conductor', '.gitignore'), 'utf8')).toBe('.env\ndata/\n');
    expect(existsSync(join(baseDir, 'config'))).toBe(false);
    expect(existsSync(join(baseDir, 'data'))).toBe(false);
    expect(validateConfig(baseDir)).toEqual([]);
    expect(loadSupervisorConfig(baseDir).paths.dataDir).toBe('./.conductor/data');
  });

  it('writes the complete effective defaults instead of a commented override stub', () => {
    ensureFleetScaffold(baseDir);
    const text = readFileSync(join(baseDir, '.conductor', 'config', 'supervisor.yaml'), 'utf8');
    const config = loadSupervisorConfig(baseDir);
    const derived = deriveInstanceDefaults(baseDir);

    expect(text).toContain('heartbeatIntervalSeconds: 30');
    expect(text).toContain('auto: false');
    expect(text).toContain('telegram:\n    enabled: false');
    expect(text).toContain('slack:\n    enabled: false');
    expect(text).not.toContain('# defaults:');
    expect(config.mcp.port).toBe(derived.port);
    expect(config.terminal.windowName).toBe(derived.windowName);
    expect(config.terminal.tmux.sessionName).toBe(derived.tmuxSessionName);
  });

  it('renders the detected backend as an explicit value', () => {
    expect(renderSupervisorConfig(baseDir, { TMUX: 'test' })).toContain('backend: tmux');
    expect(renderSupervisorConfig(baseDir, {})).toContain(
      `backend: ${process.platform === 'darwin' ? 'iterm' : 'tmux'}`,
    );
  });

  it('creates an organized owner-only environment file from the public template', () => {
    ensureFleetScaffold(baseDir);
    const template = readFileSync(join(baseDir, '.conductor', 'env.template'), 'utf8');
    const environment = join(baseDir, '.conductor', '.env');

    expect(readFileSync(environment, 'utf8')).toBe(template);
    expect(template).toContain('# Telegram');
    expect(template).toContain('# Slack');
    expect(statSync(environment).mode & 0o777).toBe(constants.S_IRUSR | constants.S_IWUSR);
  });

  it('repairs missing scaffold files without rewriting existing configuration or secrets', () => {
    const supervisorFile = join(baseDir, '.conductor', 'config', 'supervisor.yaml');
    const environmentFile = join(baseDir, '.conductor', '.env');
    mkdirSync(join(baseDir, '.conductor', 'config'), { recursive: true });
    writeFileSync(supervisorFile, 'defaults:\n  auto: true\n');
    writeFileSync(environmentFile, 'KEEP_ME=yes\n');

    const created = ensureFleetScaffold(baseDir);

    expect(created).not.toContain(supervisorFile);
    expect(created).not.toContain(environmentFile);
    expect(readFileSync(supervisorFile, 'utf8')).toContain('auto: true');
    expect(readFileSync(environmentFile, 'utf8')).toBe('KEEP_ME=yes\n');
    expect(existsSync(join(baseDir, '.conductor', 'config', 'sessions'))).toBe(true);
    expect(existsSync(join(baseDir, '.conductor', 'env.template'))).toBe(true);
    expect(existsSync(join(baseDir, '.conductor', '.gitignore'))).toBe(true);
  });

  it('is quiet and idempotent after the first start', () => {
    ensureFleetScaffold(baseDir);
    expect(ensureFleetScaffold(baseDir)).toEqual([]);
  });

  it('fills missing files in a legacy root-level fleet without migrating it implicitly', () => {
    const supervisorFile = join(baseDir, 'config', 'supervisor.yaml');
    mkdirSync(join(baseDir, 'config'), { recursive: true });
    writeFileSync(supervisorFile, 'defaults:\n  auto: true\n');

    const created = ensureFleetScaffold(baseDir);

    expect(created).toContain(join(baseDir, 'config', 'sessions'));
    expect(created).toContain(join(baseDir, 'env.template'));
    expect(created).toContain(join(baseDir, '.env'));
    expect(existsSync(join(baseDir, '.conductor'))).toBe(false);
    expect(readFileSync(supervisorFile, 'utf8')).toContain('auto: true');
  });
});

describe('conductor start initialization', () => {
  it('scaffolds an empty fleet before starting the supervisor', async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'src', 'cli', 'index.ts'), '-C', baseDir, 'start', '--foreground'],
      {
        env: { ...process.env, TMUX: 'conductor-scaffold-test' },
        stdio: 'ignore',
      },
    );

    try {
      const environmentFile = join(baseDir, '.conductor', '.env');
      const deadline = Date.now() + 5_000;
      while (!existsSync(environmentFile) && child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(environmentFile)).toBe(true);
      expect(existsSync(join(baseDir, '.conductor', 'config', 'supervisor.yaml'))).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    }
  });

  it('does not expose the removed init command', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'src', 'cli', 'index.ts'), '--help'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/^\s+init(?:\s|$)/m);
    expect(result.stdout).toContain('Initialize missing fleet files');
  });
});
