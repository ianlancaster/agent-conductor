import { spawn, spawnSync } from 'node:child_process';
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

    expect(created).toHaveLength(6);
    expect(existsSync(join(baseDir, '.conductor', 'config', 'supervisor.yaml'))).toBe(true);
    const shepherd = readFileSync(join(baseDir, '.conductor', 'config', 'pr-shepherd.yaml'), 'utf8');
    expect(shepherd).toContain('agent-conductor-pr-shepherd-scaffold: identity-required');
    expect(shepherd).toContain('bootstrap: baseline-only');
    expect(shepherd).not.toMatch(/:\s*execute\b/);
    expect(existsSync(join(baseDir, '.conductor', 'config', 'sessions'))).toBe(true);
    expect(existsSync(join(baseDir, '.conductor', 'env.template'))).toBe(true);
    expect(existsSync(join(baseDir, '.conductor', '.env'))).toBe(true);
    expect(readFileSync(join(baseDir, '.conductor', '.gitignore'), 'utf8')).toBe('.env\ndata/\n');
    expect(existsSync(join(baseDir, 'config'))).toBe(false);
    expect(existsSync(join(baseDir, 'data'))).toBe(false);
    expect(validateConfig(baseDir)).toEqual([]);
    expect(loadSupervisorConfig(baseDir).paths.dataDir).toBe('./.conductor/data');
    expect(loadSupervisorConfig(baseDir).shepherd).toMatchObject({
      enabled: false,
      presentation: 'headless',
      configPath: join(baseDir, '.conductor', 'config', 'pr-shepherd.yaml'),
    });
  });

  it('writes the complete effective defaults instead of a commented override stub', () => {
    ensureFleetScaffold(baseDir);
    const text = readFileSync(join(baseDir, '.conductor', 'config', 'supervisor.yaml'), 'utf8');
    const config = loadSupervisorConfig(baseDir);
    const derived = deriveInstanceDefaults(baseDir);

    expect(text).toContain('heartbeatIntervalSeconds: 30');
    expect(text).toContain('maxTagLength: 50');
    expect(text).toContain('auto: false');
    expect(text).toContain('events:\n  journal:\n    enabled: true');
    expect(text).toContain('telegram:\n    enabled: false');
    expect(text).toContain('slack:\n    enabled: false');
    expect(text).toContain('bypassHookTrust: true');
    expect(text).toContain('agent:\n      source: https://github.com/ianlancaster/cognitive-agent-template');
    expect(text).not.toContain('# defaults:');
    expect(config.mcp.port).toBe(derived.port);
    expect(config.terminal.windowName).toBe(derived.windowName);
    expect(config.terminal.tmux.sessionName).toBe(derived.tmuxSessionName);
    expect(config.runtimes.codex.bypassHookTrust).toBe(true);
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
    expect(created).toContain(join(baseDir, 'config', 'pr-shepherd.yaml'));
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
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    try {
      const environmentFile = join(baseDir, '.conductor', '.env');
      const deadline = Date.now() + 5_000;
      while (
        (!existsSync(environmentFile) || !stdout.includes('Initialized missing fleet files:')) &&
        child.exitCode === null &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(environmentFile)).toBe(true);
      expect(existsSync(join(baseDir, '.conductor', 'config', 'supervisor.yaml'))).toBe(true);
      expect(stdout).toContain('Initialized missing fleet files:');
      expect(stdout).not.toContain('First-session onboarding');
      expect(stdout).not.toContain('iTerm automation');
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    }
  });

  it('refuses to create a non-owning console when a conductor is already running', async () => {
    const healthServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    });
    await new Promise<void>((resolve, reject) => {
      healthServer.once('error', reject);
      healthServer.listen(0, '127.0.0.1', resolve);
    });
    const address = healthServer.address();
    if (address === null || typeof address === 'string') throw new Error('health server did not bind');
    ensureFleetScaffold(baseDir);
    writeFileSync(
      join(baseDir, '.conductor', 'config', 'supervisor.yaml'),
      `terminal:\n  backend: tmux\nmcp:\n  host: 127.0.0.1\n  port: ${String(address.port)}\nruntimes:\n  claudeCode:\n    binary: conductor-test-missing-runtime\n`,
    );

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'src', 'cli', 'index.ts'), '-C', baseDir, 'start'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    await new Promise<void>((resolve, reject) =>
      healthServer.close((error) => (error === undefined ? resolve() : reject(error))),
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('`conductor start` only opens a console that owns and stops its conductor');
    expect(stderr).toContain('Use `conductor console` for a non-owning attachment');
    expect(stderr).toContain('run `conductor kill`');
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
    expect(result.stdout).toMatch(/^\s+kill\s+/m);
  });

  it('fails startup preflight before creating a hidden conductor child', () => {
    ensureFleetScaffold(baseDir);
    writeFileSync(
      join(baseDir, '.conductor', 'config', 'supervisor.yaml'),
      'terminal:\n  backend: tmux\nmcp:\n  host: 127.0.0.1\n  port: 1\nruntimes:\n  claudeCode:\n    binary: conductor-test-missing-runtime\n',
    );

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'src', 'cli', 'index.ts'), '-C', baseDir, 'start'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Startup preflight failed');
    expect(result.stderr).toContain('conductor-test-missing-runtime is not on PATH');
    expect(existsSync(join(baseDir, '.conductor', 'data', 'conductor.out.log'))).toBe(false);
  });
});
