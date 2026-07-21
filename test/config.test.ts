import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveInstanceDefaults, PORT_RANGE_SIZE, PORT_RANGE_START } from '../src/config/instance.js';
import {
  detectBackend,
  loadSessionConfigs,
  loadConfig,
  loadSupervisorConfig,
  validateConfig,
} from '../src/config/loader.js';
import { ConfigWatcher } from '../src/config/watcher.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-config-'));
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function writeSession(name: string, content: string): void {
  writeFileSync(join(baseDir, 'config', 'sessions', `${name}.yaml`), content);
}

describe('loadSupervisorConfig', () => {
  it('applies full defaults when no config file exists', () => {
    const config = loadSupervisorConfig(baseDir);
    expect(config.supervisor.heartbeatIntervalSeconds).toBe(30);
    expect(config.mcp.host).toBe('127.0.0.1');
    expect(config.health.captureLines).toBe(40);
    expect(config.messaging.queueDrainMs).toBe(2000);
    expect(config.defaults.auto).toBe(false);
    expect(config.defaults.runtime).toBe('claude-code');
    expect(config.defaults.bypassPermissions).toBe(true);
    expect(config.health.fleetStallConfirmMs).toBe(300_000);
    expect(config.terminal.iterm.badge).toBe(true);
    expect(config.runtimes.claudeCode.binary).toBe('claude');
    expect(config.runtimes.codex.toolTimeoutSec).toBe(600);
    expect(config.spawn.markerFile).toBe('.agent-marker');
    expect(config.channels.telegram.enabled).toBe(false);
  });

  it('derives per-fleet instance defaults so two fleets never collide', () => {
    const config = loadSupervisorConfig(baseDir);
    const derived = deriveInstanceDefaults(baseDir);
    expect(config.mcp.port).toBe(derived.port);
    expect(config.mcp.port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(config.mcp.port).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
    expect(config.terminal.tmux.sessionName).toBe(derived.tmuxSessionName);
    expect(config.terminal.windowName).toBe(derived.windowName);
    // Stable across reloads — session MCP configs bake the port into URLs.
    expect(loadSupervisorConfig(baseDir).mcp.port).toBe(config.mcp.port);
  });

  it('merges partial config over defaults, explicit values beating derivation', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'mcp:\n  port: 9999\nhealth:\n  captureLines: 80\nterminal:\n  windowName: Fleet One\n  iterm:\n    badge: false\n  tmux:\n    sessionName: fleet-one\n',
    );
    const config = loadSupervisorConfig(baseDir);
    expect(config.mcp.port).toBe(9999);
    expect(config.mcp.host).toBe('127.0.0.1');
    expect(config.health.captureLines).toBe(80);
    expect(config.health.suppressSimilarity).toBe(0.8);
    expect(config.terminal.windowName).toBe('Fleet One');
    expect(config.terminal.iterm.badge).toBe(false);
    expect(config.terminal.tmux.sessionName).toBe('fleet-one');
  });

  it('allows the fleet permission bypass default to be disabled', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'defaults:\n  bypassPermissions: false\n');
    expect(loadSupervisorConfig(baseDir).defaults.bypassPermissions).toBe(false);
  });

  it('rejects invalid values with a readable error', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'mcp:\n  port: -1\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/mcp\.port/);
  });

  it('rejects unknown supervisor keys instead of silently ignoring stale or misspelled settings', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'defaults:\n  autonomy: automatic\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/defaults/);

    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'scheduler:\n  reloadIntervalBeats: 10\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/scheduler/);
  });
});

describe('backend auto-detection', () => {
  it('stays in tmux when launched inside tmux, on any platform', () => {
    expect(detectBackend({ TMUX: '/tmp/tmux-501/default,123,0' }, 'darwin')).toBe('tmux');
    expect(detectBackend({ TMUX: '/tmp/tmux-501/default,123,0' }, 'linux')).toBe('tmux');
  });

  it('falls back to the platform default outside tmux: iterm on macOS, tmux elsewhere', () => {
    expect(detectBackend({}, 'darwin')).toBe('iterm');
    expect(detectBackend({}, 'linux')).toBe('tmux');
    // An empty TMUX var is not "inside tmux".
    expect(detectBackend({ TMUX: '' }, 'darwin')).toBe('iterm');
  });

  it('loader resolves an unset backend from the environment', () => {
    expect(loadSupervisorConfig(baseDir, { TMUX: 'socket,1,0' }).terminal.backend).toBe('tmux');
  });

  it('explicit config beats detection', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'terminal:\n  backend: iterm\n');
    expect(loadSupervisorConfig(baseDir, { TMUX: 'socket,1,0' }).terminal.backend).toBe('iterm');
  });
});

describe('loadSessionConfigs', () => {
  it('loads sessions and resolves relative repo paths', () => {
    writeSession('alpha', 'codename: alpha\nrepo: ./alpha-repo\n');
    const sessions = loadSessionConfigs(baseDir);
    expect(sessions.size).toBe(1);
    const alpha = sessions.get('alpha');
    expect(alpha?.repo).toBe(join(baseDir, 'alpha-repo'));
    expect(alpha?.runtime).toBe('claude-code');
    expect(alpha?.schedules).toEqual([]);
  });

  it('keeps absolute repo paths untouched', () => {
    writeSession('alpha', 'codename: alpha\nrepo: /tmp/alpha\n');
    expect(loadSessionConfigs(baseDir).get('alpha')?.repo).toBe('/tmp/alpha');
  });

  it('uses the configured default runtime while preserving per-session overrides', () => {
    writeSession('alpha', 'codename: alpha\nrepo: /tmp/alpha\n');
    writeSession('beta', 'codename: beta\nrepo: /tmp/beta\nruntime: claude-code\n');
    const sessions = loadSessionConfigs(baseDir, { defaultRuntime: 'codex' });
    expect(sessions.get('alpha')?.runtime).toBe('codex');
    expect(sessions.get('beta')?.runtime).toBe('claude-code');
  });

  it('parses codex runtime and schedules', () => {
    writeSession(
      'beta',
      [
        'codename: beta',
        'repo: /tmp/beta',
        'runtime: codex',
        'schedules:',
        '  - cron: "0 9 * * *"',
        '    prompt: good morning',
      ].join('\n'),
    );
    const beta = loadSessionConfigs(baseDir).get('beta');
    expect(beta?.runtime).toBe('codex');
    expect(beta?.schedules[0]?.cron).toBe('0 9 * * *');
    expect(beta?.schedules[0]?.paused).toBe(false);
  });

  it('parses a per-session permission override without forcing one onto every session', () => {
    writeSession('alpha', 'codename: alpha\nrepo: /tmp/alpha\nbypassPermissions: false\n');
    writeSession('beta', 'codename: beta\nrepo: /tmp/beta\n');
    expect(loadSessionConfigs(baseDir).get('alpha')?.bypassPermissions).toBe(false);
    expect(loadSessionConfigs(baseDir).get('beta')?.bypassPermissions).toBeUndefined();
  });

  it('throws on malformed config by default', () => {
    writeSession('bad', 'codename: bad\n'); // missing repo
    expect(() => loadSessionConfigs(baseDir)).toThrow(/repo/);
  });

  it('skips malformed files in tolerant mode', () => {
    writeSession('bad', 'codename: bad\n');
    writeSession('good', 'codename: good\nrepo: /tmp/good\n');
    const sessions = loadSessionConfigs(baseDir, { tolerant: true });
    expect([...sessions.keys()]).toEqual(['good']);
  });

  it('rejects duplicate codenames', () => {
    writeSession('one', 'codename: dupe\nrepo: /tmp/a\n');
    writeSession('two', 'codename: dupe\nrepo: /tmp/b\n');
    expect(() => loadSessionConfigs(baseDir)).toThrow(/Duplicate codename/);
  });

  it('rejects invalid codenames', () => {
    writeSession('bad', 'codename: "has space"\nrepo: /tmp/x\n');
    expect(() => loadSessionConfigs(baseDir)).toThrow(/codename/);
  });

  it('rejects unknown session and schedule keys', () => {
    writeSession('alpha', 'codename: alpha\nrepo: /tmp/alpha\nautonomy: autonomous\n');
    expect(() => loadSessionConfigs(baseDir)).toThrow(/autonomy/);

    writeSession(
      'alpha',
      'codename: alpha\nrepo: /tmp/alpha\nschedules:\n  - cron: "0 9 * * *"\n    prompt: work\n    backfill: true\n',
    );
    expect(() => loadSessionConfigs(baseDir)).toThrow(/backfill/);
  });
});

describe('validateConfig', () => {
  it('returns empty list for a valid setup', () => {
    writeSession('alpha', 'codename: alpha\nrepo: /tmp/alpha\n');
    expect(validateConfig(baseDir)).toEqual([]);
  });

  it('collects all problems instead of failing fast', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'mcp:\n  port: nope\n');
    writeSession('bad', 'codename: bad\n');
    const problems = validateConfig(baseDir);
    expect(problems.length).toBe(2);
  });
});

describe('loadConfig', () => {
  it('returns supervisor + sessions together', () => {
    writeSession('alpha', 'codename: alpha\nrepo: /tmp/alpha\n');
    const config = loadConfig(baseDir);
    expect(config.sessions.has('alpha')).toBe(true);
    expect(config.baseDir).toBe(baseDir);
  });

  it('applies supervisor defaults.runtime to session files that omit runtime', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'defaults:\n  runtime: codex\n');
    writeSession('alpha', 'codename: alpha\nrepo: /tmp/alpha\n');
    expect(loadConfig(baseDir).sessions.get('alpha')?.runtime).toBe('codex');
  });

  it('keeps every published configuration example valid', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      readFileSync(new URL('../examples/supervisor.yaml', import.meta.url), 'utf8'),
    );
    for (const name of ['example-claude', 'example-codex', 'example-sentinel']) {
      writeSession(name, readFileSync(new URL(`../examples/sessions/${name}.yaml`, import.meta.url), 'utf8'));
    }
    expect(loadConfig(baseDir).sessions.size).toBe(3);
  });
});

describe('ConfigWatcher', () => {
  it('detects added, modified, and removed files', async () => {
    const dir = join(baseDir, 'config', 'sessions');
    const watcher = new ConfigWatcher(dir);
    let fired = 0;
    watcher.onChange(() => {
      fired += 1;
    });

    expect(watcher.checkNow()).toBe(false);

    writeSession('alpha', 'codename: alpha\nrepo: /tmp/a\n');
    expect(watcher.checkNow()).toBe(true);
    expect(fired).toBe(1);

    // mtime granularity — force a distinct mtime
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeSession('alpha', 'codename: alpha\nrepo: /tmp/b\n');
    expect(watcher.checkNow()).toBe(true);

    rmSync(join(dir, 'alpha.yaml'));
    expect(watcher.checkNow()).toBe(true);
    expect(watcher.checkNow()).toBe(false);
  });
});
