import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveInstanceDefaults, PORT_RANGE_SIZE, PORT_RANGE_START } from '../src/config/instance.js';
import { loadAgentConfigs, loadConfig, loadSupervisorConfig, validateConfig } from '../src/config/loader.js';
import { ConfigWatcher } from '../src/config/watcher.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-config-'));
  mkdirSync(join(baseDir, 'config', 'agents'), { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function writeAgent(name: string, content: string): void {
  writeFileSync(join(baseDir, 'config', 'agents', `${name}.yaml`), content);
}

describe('loadSupervisorConfig', () => {
  it('applies full defaults when no config file exists', () => {
    const config = loadSupervisorConfig(baseDir);
    expect(config.supervisor.heartbeatIntervalSeconds).toBe(30);
    expect(config.mcp.host).toBe('127.0.0.1');
    expect(config.health.captureLines).toBe(40);
    expect(config.messaging.queueDrainMs).toBe(2000);
    expect(config.defaults.autonomy).toBe('facilitated');
    expect(config.terminal.backend).toBe('iterm');
    expect(config.runtimes.claudeCode.binary).toBe('claude');
    expect(config.runtimes.codex.toolTimeoutSec).toBe(600);
    expect(config.spawn.markerFile).toBe('.conductor-agent');
  });

  it('derives per-fleet instance defaults so two fleets never collide', () => {
    const config = loadSupervisorConfig(baseDir);
    const derived = deriveInstanceDefaults(baseDir);
    expect(config.mcp.port).toBe(derived.port);
    expect(config.mcp.port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(config.mcp.port).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
    expect(config.terminal.tmux.sessionName).toBe(derived.tmuxSessionName);
    expect(config.terminal.windowName).toBe(derived.windowName);
    // Stable across reloads — agent MCP configs bake the port into URLs.
    expect(loadSupervisorConfig(baseDir).mcp.port).toBe(config.mcp.port);
  });

  it('merges partial config over defaults, explicit values beating derivation', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'mcp:\n  port: 9999\nhealth:\n  captureLines: 80\nterminal:\n  windowName: Fleet One\n  tmux:\n    sessionName: fleet-one\n',
    );
    const config = loadSupervisorConfig(baseDir);
    expect(config.mcp.port).toBe(9999);
    expect(config.mcp.host).toBe('127.0.0.1');
    expect(config.health.captureLines).toBe(80);
    expect(config.health.suppressSimilarity).toBe(0.8);
    expect(config.terminal.windowName).toBe('Fleet One');
    expect(config.terminal.tmux.sessionName).toBe('fleet-one');
  });

  it('rejects invalid values with a readable error', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'mcp:\n  port: -1\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/mcp\.port/);
  });
});

describe('loadAgentConfigs', () => {
  it('loads agents and resolves relative repo paths', () => {
    writeAgent('alpha', 'codename: alpha\nrepo: ./alpha-repo\n');
    const agents = loadAgentConfigs(baseDir);
    expect(agents.size).toBe(1);
    const alpha = agents.get('alpha');
    expect(alpha?.repo).toBe(join(baseDir, 'alpha-repo'));
    expect(alpha?.runtime).toBe('claude-code');
    expect(alpha?.schedules).toEqual([]);
  });

  it('keeps absolute repo paths untouched', () => {
    writeAgent('alpha', 'codename: alpha\nrepo: /tmp/alpha\n');
    expect(loadAgentConfigs(baseDir).get('alpha')?.repo).toBe('/tmp/alpha');
  });

  it('parses codex runtime and schedules', () => {
    writeAgent(
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
    const beta = loadAgentConfigs(baseDir).get('beta');
    expect(beta?.runtime).toBe('codex');
    expect(beta?.schedules[0]?.cron).toBe('0 9 * * *');
    expect(beta?.schedules[0]?.paused).toBe(false);
  });

  it('throws on malformed config by default', () => {
    writeAgent('bad', 'codename: bad\n'); // missing repo
    expect(() => loadAgentConfigs(baseDir)).toThrow(/repo/);
  });

  it('skips malformed files in tolerant mode', () => {
    writeAgent('bad', 'codename: bad\n');
    writeAgent('good', 'codename: good\nrepo: /tmp/good\n');
    const agents = loadAgentConfigs(baseDir, { tolerant: true });
    expect([...agents.keys()]).toEqual(['good']);
  });

  it('rejects duplicate codenames', () => {
    writeAgent('one', 'codename: dupe\nrepo: /tmp/a\n');
    writeAgent('two', 'codename: dupe\nrepo: /tmp/b\n');
    expect(() => loadAgentConfigs(baseDir)).toThrow(/Duplicate codename/);
  });

  it('rejects invalid codenames', () => {
    writeAgent('bad', 'codename: "has space"\nrepo: /tmp/x\n');
    expect(() => loadAgentConfigs(baseDir)).toThrow(/codename/);
  });
});

describe('validateConfig', () => {
  it('returns empty list for a valid setup', () => {
    writeAgent('alpha', 'codename: alpha\nrepo: /tmp/alpha\n');
    expect(validateConfig(baseDir)).toEqual([]);
  });

  it('collects all problems instead of failing fast', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'mcp:\n  port: nope\n');
    writeAgent('bad', 'codename: bad\n');
    const problems = validateConfig(baseDir);
    expect(problems.length).toBe(2);
  });
});

describe('loadConfig', () => {
  it('returns supervisor + agents together', () => {
    writeAgent('alpha', 'codename: alpha\nrepo: /tmp/alpha\n');
    const config = loadConfig(baseDir);
    expect(config.agents.has('alpha')).toBe(true);
    expect(config.baseDir).toBe(baseDir);
  });
});

describe('ConfigWatcher', () => {
  it('detects added, modified, and removed files', async () => {
    const dir = join(baseDir, 'config', 'agents');
    const watcher = new ConfigWatcher(dir);
    let fired = 0;
    watcher.onChange(() => {
      fired += 1;
    });

    expect(watcher.checkNow()).toBe(false);

    writeAgent('alpha', 'codename: alpha\nrepo: /tmp/a\n');
    expect(watcher.checkNow()).toBe(true);
    expect(fired).toBe(1);

    // mtime granularity — force a distinct mtime
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeAgent('alpha', 'codename: alpha\nrepo: /tmp/b\n');
    expect(watcher.checkNow()).toBe(true);

    rmSync(join(dir, 'alpha.yaml'));
    expect(watcher.checkNow()).toBe(true);
    expect(watcher.checkNow()).toBe(false);
  });
});
