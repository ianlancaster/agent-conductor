import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Supervisor } from '../src/core/supervisor.js';
import type { ChannelAdapter, ChannelHandlers, ChannelMessage } from '../src/channels/types.js';

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

  it('fails clearly when Slack is enabled without its credentials', () => {
    writeConfig('terminal:\n  backend: tmux\nchannels:\n  slack:\n    enabled: true\n', {});
    expect(() => new Supervisor(baseDir, { env: {} })).toThrow(
      /CONDUCTOR_SLACK_BOT_TOKEN.*CONDUCTOR_SLACK_APP_TOKEN.*CONDUCTOR_SLACK_OPERATOR_USER_ID/,
    );
  });

  it('rolls back started channels and the MCP listener when a later channel fails startup', async () => {
    const port = await freePort();
    writeConfig(`terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\n`, {});
    const first = new ControlledChannel('first');
    const failure = new ControlledChannel('failure', new Error('Slack preflight failed'));
    supervisor = new Supervisor(baseDir, {
      channels: [first, failure],
      includeConfiguredChannels: false,
      env: {},
    });

    await expect(supervisor.start()).rejects.toThrow('Slack preflight failed');
    expect(first.stopCount).toBe(1);
    expect(failure.stopCount).toBe(0);
    await expect(canListen(port)).resolves.toBe(true);

    // Failed startup released the fleet lock as well as the port.
    await supervisor.stop();
    supervisor = new Supervisor(baseDir, { channels: [], includeConfiguredChannels: false, env: {} });
    await supervisor.start();
  });

  it('fans operator notifications out concurrently across adapters', async () => {
    const port = await freePort();
    writeConfig(`terminal:\n  backend: tmux\nmcp:\n  port: ${String(port)}\n`, {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    let releaseSlow: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = new ControlledChannel('slow', undefined, async () => blocked);
    const fast = new ControlledChannel('fast');
    supervisor = new Supervisor(baseDir, {
      channels: [slow, fast],
      includeConfiguredChannels: false,
      env: {},
    });
    await supervisor.start();

    const response = fetch(`http://127.0.0.1:${String(port)}/mcp/alpha`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_to_operator', arguments: { message: 'Ready?' } },
      }),
    });
    await until(() => fast.sent.length === 1);
    expect(slow.sent).toHaveLength(1);
    releaseSlow?.();
    expect((await response).status).toBe(200);
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

class ControlledChannel implements ChannelAdapter {
  readonly sent: ChannelMessage[] = [];
  stopCount = 0;

  constructor(
    readonly name: string,
    private readonly startError?: Error,
    private readonly onSend?: (message: ChannelMessage) => Promise<void>,
  ) {}

  async start(_handlers: ChannelHandlers): Promise<void> {
    if (this.startError !== undefined) throw this.startError;
  }

  async send(message: ChannelMessage): Promise<void> {
    this.sent.push(message);
    await this.onSend?.(message);
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function canListen(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
