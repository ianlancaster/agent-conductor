import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Supervisor } from '../src/core/supervisor.js';

let baseDir: string;
let supervisor: Supervisor | undefined;

function writeConfig(supervisorYaml: string, sessions: Record<string, string>): void {
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), supervisorYaml);
  for (const [name, content] of Object.entries(sessions)) {
    writeFileSync(join(baseDir, 'config', 'sessions', `${name}.yaml`), content);
  }
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-sup-'));
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  rmSync(baseDir, { recursive: true, force: true });
});

/**
 * Construction smoke test: the full dependency graph must assemble from config
 * alone — wiring mistakes (wrong config slice, circular init) fail here instead
 * of at runtime. No terminal/network side effects before start().
 */
describe('Supervisor construction', () => {
  it('assembles the full graph from a tmux config and reports status', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43391\nsentinel:\n  codename: watch\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      watch: `codename: watch\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);

    const status = supervisor.statusReport();
    expect(status).toContain('Sessions:');
    expect(status).toContain('alpha');
    expect(status).toContain('watch');
    expect(status).toContain('🛡'); // sentinel marker
  });

  it('assembles with the iTerm backend and never nags about a missing sentinel', () => {
    writeConfig('terminal:\n  backend: iterm\nmcp:\n  port: 43392\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).not.toContain('sentinel');
  });

  it('fails fast when Telegram is enabled without both credentials', () => {
    writeConfig('terminal:\n  backend: tmux\nchannels:\n  telegram:\n    enabled: true\n', {});
    expect(() => new Supervisor(baseDir, { env: {} })).toThrow(/CONDUCTOR_TELEGRAM_TOKEN.*CHAT_ID.*missing or blank/);
  });

  it('honors injected/global environment over fleet .env for configured channels', () => {
    writeConfig('terminal:\n  backend: tmux\nchannels:\n  telegram:\n    enabled: true\n', {});
    writeFileSync(join(baseDir, '.env'), 'CONDUCTOR_TELEGRAM_TOKEN=file-token\nCONDUCTOR_TELEGRAM_CHAT_ID=file-chat\n');
    supervisor = new Supervisor(baseDir, {
      env: { CONDUCTOR_TELEGRAM_TOKEN: 'inherited-token', CONDUCTOR_TELEGRAM_CHAT_ID: 'inherited-chat' },
    });
    expect(supervisor.config.channels.telegram.enabled).toBe(true);
  });

  it('bypasses bundled channel discovery while retaining deterministic environment detection', () => {
    writeConfig('channels:\n  telegram:\n    enabled: true\n', {});
    supervisor = new Supervisor(baseDir, {
      env: { TMUX: 'socket,1,0' },
      includeConfiguredChannels: false,
    });
    expect(supervisor.config.terminal.backend).toBe('tmux');
  });

  it('applies a Codex default runtime to sessions that omit runtime', () => {
    writeConfig(
      'terminal:\n  backend: iterm\nmcp:\n  port: 43390\ndefaults:\n  runtime: codex\nruntimes:\n  codex:\n    defaultModel: gpt-5.6-sol\n    defaultEffort: xhigh\n',
      {
        alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      },
    );
    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).toContain('alpha - codex ·');
    expect(supervisor.statusReport('alpha')).toContain('"runtime": "codex"');
    expect(supervisor.statusReport('alpha')).toContain('"model": "gpt-5.6-sol"');
    expect(supervisor.statusReport('alpha')).toContain('"effort": "xhigh"');
  });

  it('reports the configured path and current branch in detailed and fleet status', () => {
    const repo = join(baseDir, 'session-repo');
    mkdirSync(repo);
    const gitEnv = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) {
      delete gitEnv[key];
    }
    execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'ignore', env: gitEnv });
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43390\n', {
      alpha: `codename: alpha\nrepo: ${repo}\n`,
    });
    supervisor = new Supervisor(baseDir);

    const detailed = JSON.parse(supervisor.statusReport('alpha')) as { path: unknown; branch: unknown };
    expect(detailed.path).toBe(repo);
    expect(detailed.branch).toBe('main');
    expect(supervisor.statusReport()).toContain(`path: ${repo} · branch: main`);
  });

  it('routes operator commands through the shared router', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43393\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);

    expect(await supervisor.command('/help')).toContain('/status');
    expect(await supervisor.command('/start ghost')).toBe('Unknown session: ghost');
    expect(await supervisor.command('/tag alpha smoke test')).toContain('smoke test');
    expect(await supervisor.command('/auto alpha')).toBe('alpha: auto on');
    expect(supervisor.statusReport('alpha')).toContain('"auto": true');
  });

  it('persists session state across supervisor instances (single SQLite store)', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43394\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    await supervisor.command('/auto alpha');
    await supervisor.command('/tag alpha carry-over');
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    const status = supervisor.statusReport('alpha');
    expect(status).toContain('"auto": true');
    expect(status).toContain('"tag": "carry-over"');
  });

  it('persists a tool-set sentinel override and a cleared designation', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43398\nsentinel:\n  codename: watch\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      watch: `codename: watch\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    supervisor.setSentinel('alpha');
    expect(supervisor.statusReport('alpha')).toContain('"isSentinel": true');
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport('alpha')).toContain('"isSentinel": true');
    expect(supervisor.statusReport('watch')).toContain('"isSentinel": false');
    supervisor.setSentinel(undefined);
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).not.toContain('🛡');
  });

  it('keeps persisted state when a config transiently fails to parse (M13)', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43396\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    await supervisor.command('/auto alpha');

    // Simulate an editor's mid-write atomic save: the file exists but is invalid.
    writeFileSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'), 'codename: alpha\nrepo:\n  - bad');
    await supervisor.command('/status'); // any op; the reload runs on the watcher, so force one:
    supervisor.reloadSessionsForTest();

    expect(supervisor.statusReport()).toContain('alpha');
    expect(supervisor.statusReport('alpha')).toContain('"auto": true');
  });

  it('deregisters and clears state when a config is genuinely removed', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43397\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    await supervisor.command('/auto alpha');
    rmSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'));
    supervisor.reloadSessionsForTest();
    expect(supervisor.statusReport()).toContain('No sessions configured');
  });

  it('groups marker-file repos under the Agents header in status', () => {
    const repo = join(baseDir, 'session-repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.agent-marker'), '');
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43395\n', {
      alpha: `codename: alpha\nrepo: ${repo}\n`,
      beta: `codename: beta\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    const status = supervisor.statusReport();
    const agentsAt = status.indexOf('Agents:');
    const sessionsAt = status.indexOf('Sessions:');
    expect(agentsAt).toBeGreaterThanOrEqual(0);
    expect(sessionsAt).toBeGreaterThan(agentsAt);
    expect(status.slice(agentsAt, sessionsAt)).toContain('alpha');
    expect(status.slice(sessionsAt)).toContain('beta');
  });
});
