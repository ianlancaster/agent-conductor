import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveFleetDefaults, PORT_RANGE_SIZE, PORT_RANGE_START } from '../src/config/derived-defaults.js';
import {
  detectBackend,
  loadSessionConfigs,
  loadConfig,
  loadSupervisorConfig,
  sessionConfigDir,
  validateConfig,
  validateFederationExposure,
} from '../src/config/loader.js';
import { resolveConductorInstance, resolveFleetPaths } from '../src/config/paths.js';
import { allowsSelfAuto } from '../src/config/schema.js';
import { ConfigWatcher } from '../src/config/watcher.js';
import {
  DEFAULT_CLAUDE_CODE_EFFORTS,
  DEFAULT_CLAUDE_CODE_MODELS,
  DEFAULT_CODEX_EFFORTS,
  DEFAULT_CODEX_MODELS,
  DEFAULT_MAX_TAG_LENGTH,
  DEFAULT_SPAWN_TEMPLATES,
} from '../src/config/schema.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-config-'));
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), '');
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function writeSession(name: string, content: string): void {
  writeFileSync(join(baseDir, 'config', 'sessions', `${name}.yaml`), content);
}

describe('loadSupervisorConfig', () => {
  it('preserves trimmed external runtime names for registry-time validation', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'defaults:\n  runtime: " external "\n');
    expect(loadSupervisorConfig(baseDir).defaults.runtime).toBe('external');
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'defaults:\n  runtime: "   "\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow('runtime must be a non-empty name');
  });

  it('applies full defaults when no config file exists', () => {
    const config = loadSupervisorConfig(baseDir);
    expect(config.supervisor.heartbeatIntervalSeconds).toBe(30);
    expect(config.supervisor.maxTagLength).toBe(DEFAULT_MAX_TAG_LENGTH);
    expect(config.mcp.host).toBe('127.0.0.1');
    expect(config.health.captureLines).toBe(40);
    expect(config.messaging.queueDrainMs).toBe(2000);
    expect(config.defaults.auto).toBe(false);
    expect(config.defaults.runtime).toBe('claude-code');
    expect(config.defaults.bypassPermissions).toBe(true);
    expect(config.defaults.allowSelfAuto).toBe(false);
    expect(config.health.fleetStallConfirmMs).toBe(15_000);
    expect(config.terminal.iterm.badge).toBe(true);
    expect(config.runtimes.claudeCode.binary).toBe('claude');
    expect(config.runtimes.claudeCode.availableModels).toEqual(DEFAULT_CLAUDE_CODE_MODELS);
    expect(config.runtimes.claudeCode.availableEfforts).toEqual(DEFAULT_CLAUDE_CODE_EFFORTS);
    expect(config.runtimes.claudeCode.defaultEffort).toBeUndefined();
    expect(config.runtimes.codex.toolTimeoutSec).toBe(600);
    expect(config.runtimes.codex.bypassHookTrust).toBe(true);
    expect(config.runtimes.codex.availableModels).toEqual(DEFAULT_CODEX_MODELS);
    expect(config.runtimes.codex.availableEfforts).toEqual(DEFAULT_CODEX_EFFORTS);
    expect(config.runtimes.codex.defaultEffort).toBeUndefined();
    expect(config.runtimes.spartan.binary).toBe('spartan');
    expect(config.spawn.markerFile).toBe('.agent-marker');
    expect(config.spawn.templates).toEqual(DEFAULT_SPAWN_TEMPLATES);
    expect(config.spawn.templateCloneTimeoutSeconds).toBe(120);
    expect(config.channels.telegram.enabled).toBe(false);
    expect(config.channels.slack.enabled).toBe(false);
    expect(config.shepherd).toEqual({
      enabled: false,
      presentation: 'headless',
      configPath: join(baseDir, 'config', 'pr-shepherd.yaml'),
    });
    expect(config.paths.dataDir).toBe('./data');
    expect(config.runbooks.paths).toEqual([]);
    expect(config.events.journal.enabled).toBe(true);
    expect(config.integrations).toEqual([]);
    expect(config.federation).toBeUndefined();
  });

  it('loads minimal explicit and wildcard federation configuration', () => {
    writeSession('alpha', 'codename: alpha\nrepo: ./alpha\n');
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'federation:\n  name: frontend\n  expose:\n    - alpha\n',
    );
    expect(loadConfig(baseDir).supervisor.federation).toEqual({ name: 'frontend', expose: ['alpha'] });

    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'federation:\n  name: frontend\n  expose:\n    - "*"\n');
    expect(loadConfig(baseDir).supervisor.federation?.expose).toEqual(['*']);
  });

  it('rejects unsafe federation names, mixed wildcards, and duplicates while allowing exposure reservations', () => {
    writeSession('alpha', 'codename: alpha\nrepo: ./alpha\n');
    for (const yaml of [
      'federation:\n  name: ../frontend\n  expose: []\n',
      'federation:\n  name: frontend\n  expose: ["*", alpha]\n',
      'federation:\n  name: frontend\n  expose: [alpha, alpha]\n',
    ]) {
      writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), yaml);
      expect(() => loadConfig(baseDir)).toThrow();
    }

    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'federation:\n  name: frontend\n  expose: [missing]\n');
    expect(loadConfig(baseDir).supervisor.federation?.expose).toEqual(['missing']);
    expect(validateConfig(baseDir)).toEqual([]);
  });

  it('requires a loopback MCP bind when federation is enabled', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'mcp:\n  host: 0.0.0.0\nfederation:\n  name: frontend\n  expose: []\n',
    );
    expect(() => loadConfig(baseDir)).toThrow(/mcp\.host must be 127\.0\.0\.1 or localhost/);
    expect(validateConfig(baseDir)).toEqual([expect.stringMatching(/mcp\.host must be 127\.0\.0\.1 or localhost/)]);
  });

  it('rejects an unparsed exposed session while allowing a genuinely absent reservation', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'federation:\n  name: frontend\n  expose: [alpha]\n');
    writeSession('alpha', 'codename: [\n');
    const supervisor = loadSupervisorConfig(baseDir);
    const sessions = loadSessionConfigs(baseDir, { tolerant: true });
    expect(() =>
      validateFederationExposure(supervisor, sessions, join(baseDir, 'config', 'supervisor.yaml'), {
        sessionsDir: join(baseDir, 'config', 'sessions'),
      }),
    ).toThrow(/exposed session configuration failed to parse: alpha/);

    rmSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'));
    expect(() =>
      validateFederationExposure(supervisor, sessions, join(baseDir, 'config', 'supervisor.yaml'), {
        sessionsDir: join(baseDir, 'config', 'sessions'),
      }),
    ).not.toThrow();
  });

  it('preserves an explicit opt-out from the Codex hook-trust default', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'runtimes:\n  codex:\n    bypassHookTrust: false\n');
    expect(loadSupervisorConfig(baseDir).runtimes.codex.bypassHookTrust).toBe(false);
  });

  it('resolves a strict root-level Shepherd config beside supervisor.yaml', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'shepherd:\n  enabled: true\n  configPath: ./profiles/shepherd.yaml\n  presentation: panel\n',
    );
    expect(loadSupervisorConfig(baseDir).shepherd).toEqual({
      enabled: true,
      presentation: 'panel',
      configPath: join(baseDir, 'config', 'profiles', 'shepherd.yaml'),
    });
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'shepherd:\n  surprise: true\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/shepherd: Unrecognized key.*surprise/);
  });

  it('accepts a configurable template registry and permits explicitly disabling all templates', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'spawn:\n  templates:\n    review:\n      source: ../review-template\n      ref: stable\n  templateCloneTimeoutSeconds: 45\n',
    );
    const configured = loadSupervisorConfig(baseDir);
    expect(configured.spawn.templates).toEqual({
      review: { source: '../review-template', ref: 'stable' },
    });
    expect(configured.spawn.templateCloneTimeoutSeconds).toBe(45);

    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'spawn:\n  templates: {}\n');
    expect(loadSupervisorConfig(baseDir).spawn.templates).toEqual({});
  });

  it('accepts only a strict list of additional local runbook paths', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'runbooks:\n  paths:\n    - ../shared-runbooks\n    - /opt/team-runbooks\n',
    );
    expect(loadSupervisorConfig(baseDir).runbooks.paths).toEqual(['../shared-runbooks', '/opt/team-runbooks']);

    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'runbooks:\n  enabled: true\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/runbooks/);
  });

  it('accepts a positive fleet-wide tag limit and rejects invalid limits', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'supervisor:\n  maxTagLength: 24\n');
    expect(loadSupervisorConfig(baseDir).supervisor.maxTagLength).toBe(24);

    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'supervisor:\n  maxTagLength: 0\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/maxTagLength/);

    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'supervisor:\n  maxTagLength: 2.5\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/maxTagLength/);
  });

  it('allows the durable event journal to be disabled without accepting extra knobs', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'events:\n  journal:\n    enabled: false\n');
    expect(loadSupervisorConfig(baseDir).events.journal.enabled).toBe(false);

    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'events:\n  journal:\n    retentionDays: 30\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/events/);
  });

  it('accepts only strict configured integration entries with opaque option mappings', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'integrations:\n  - module: ./integrations/water-cooler.mjs\n    options:\n      targetSession: assistant\n      nested:\n        enabled: true\n',
    );
    expect(loadSupervisorConfig(baseDir).integrations).toEqual([
      {
        module: './integrations/water-cooler.mjs',
        options: { targetSession: 'assistant', nested: { enabled: true } },
      },
    ]);

    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'integrations:\n  - module: ./integration.mjs\n    options: [not, a, mapping]\n',
    );
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/integrations/);

    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'integrations:\n  - module: ./integration.mjs\n    enabled: true\n',
    );
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/integrations/);
  });

  it('rejects malformed template registry entries', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'spawn:\n  templates:\n    "../unsafe":\n      source: https://example.invalid/template.git\n',
    );
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/template name/);

    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'spawn:\n  templates:\n    empty:\n      source: ""\n');
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/source/);

    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'spawn:\n  templates:\n    unsafe-ref:\n      source: ./template\n      ref: --orphan\n',
    );
    expect(() => loadSupervisorConfig(baseDir)).toThrow(/template ref/);
  });

  it('uses the hidden data directory for the preferred .conductor layout', () => {
    rmSync(join(baseDir, 'config'), { recursive: true });
    mkdirSync(join(baseDir, '.conductor', 'config', 'sessions'), { recursive: true });

    expect(loadSupervisorConfig(baseDir).paths.dataDir).toBe('./.conductor/data');
    expect(resolveFleetPaths(baseDir).supervisorFile).toBe(join(baseDir, '.conductor', 'config', 'supervisor.yaml'));
    expect(sessionConfigDir(baseDir)).toBe(join(baseDir, '.conductor', 'config', 'sessions'));
    expect(resolveFleetPaths(baseDir).runbooksDir).toBe(join(baseDir, '.conductor', 'runbooks'));
  });

  it('resolves named instances under .conductor without changing workspace roots', () => {
    rmSync(join(baseDir, 'config'), { recursive: true });
    const resolved = resolveConductorInstance(baseDir, 'frontend');

    expect(resolved.baseDir).toBe(baseDir);
    expect(resolved.name).toBe('frontend');
    expect(resolved.paths.rootDir).toBe(join(baseDir, '.conductor', 'instances', 'frontend'));
    expect(resolved.paths.sessionsDir).toBe(join(baseDir, '.conductor', 'instances', 'frontend', 'config', 'sessions'));
    expect(resolved.paths.dataDirDefault).toBe('./.conductor/instances/frontend/data');
    expect(loadSupervisorConfig(resolved).paths.dataDir).toBe('./.conductor/instances/frontend/data');
  });

  it('rejects reserved, unsafe, and legacy-root named instances', () => {
    expect(() => resolveFleetPaths(baseDir, 'default')).toThrow(/reserved/);
    expect(() => resolveFleetPaths(baseDir, '../other')).toThrow(/must match/);
    expect(() => resolveFleetPaths(baseDir, 'frontend')).toThrow(/legacy root layout/);
  });

  it('rejects ambiguous preferred and legacy configuration layouts', () => {
    mkdirSync(join(baseDir, '.conductor', 'config', 'sessions'), { recursive: true });
    writeFileSync(join(baseDir, '.conductor', 'config', 'supervisor.yaml'), '');

    expect(() => loadSupervisorConfig(baseDir)).toThrow(/Ambiguous Conductor fleet layout/);
    expect(validateConfig(baseDir)).toEqual([expect.stringMatching(/Ambiguous Conductor fleet layout/)]);
  });

  it('does not mistake an unrelated empty config/sessions directory for a legacy fleet', () => {
    rmSync(join(baseDir, 'config', 'supervisor.yaml'));

    expect(resolveFleetPaths(baseDir).layout).toBe('conductor-directory');
  });

  it('derives per-fleet instance defaults so two fleets never collide', () => {
    const config = loadSupervisorConfig(baseDir);
    const derived = deriveFleetDefaults(baseDir);
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
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'defaults:\n  allowSelfAuto: true\n');
    expect(loadSupervisorConfig(baseDir).defaults.allowSelfAuto).toBe(true);
  });

  it('accepts replacement model-hint lists without restricting model IDs', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'runtimes:\n  claudeCode:\n    availableModels: [claude-private]\n  codex:\n    availableModels: [third-party/model]\n',
    );
    const config = loadSupervisorConfig(baseDir);
    expect(config.runtimes.claudeCode.availableModels).toEqual(['claude-private']);
    expect(config.runtimes.codex.availableModels).toEqual(['third-party/model']);
  });

  it('accepts fleet effort defaults and replacement hints without restricting levels', () => {
    writeFileSync(
      join(baseDir, 'config', 'supervisor.yaml'),
      'runtimes:\n  claudeCode:\n    defaultEffort: frontier\n    availableEfforts: [eco, frontier]\n  codex:\n    defaultEffort: provider-max\n    availableEfforts: [provider-max]\n',
    );
    const config = loadSupervisorConfig(baseDir);
    expect(config.runtimes.claudeCode).toMatchObject({
      defaultEffort: 'frontier',
      availableEfforts: ['eco', 'frontier'],
    });
    expect(config.runtimes.codex).toMatchObject({
      defaultEffort: 'provider-max',
      availableEfforts: ['provider-max'],
    });
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

  it('resolves the self-auto policy from the session first and the fleet default second', () => {
    writeSession('inherits', 'codename: inherits\nrepo: /tmp/inherits\n');
    writeSession('grants', 'codename: grants\nrepo: /tmp/grants\nallowSelfAuto: true\n');
    writeSession('withholds', 'codename: withholds\nrepo: /tmp/withholds\nallowSelfAuto: false\n');
    const sessions = loadSessionConfigs(baseDir);

    expect(sessions.get('inherits')?.allowSelfAuto).toBeUndefined();
    expect(allowsSelfAuto(sessions.get('inherits'), false)).toBe(false);
    expect(allowsSelfAuto(sessions.get('inherits'), true)).toBe(true);

    // An explicit session value wins in both directions, so a fleet can open the
    // policy and still withhold it from one session.
    expect(allowsSelfAuto(sessions.get('grants'), false)).toBe(true);
    expect(allowsSelfAuto(sessions.get('withholds'), true)).toBe(false);

    // An unregistered codename has no override and takes the fleet default.
    expect(allowsSelfAuto(undefined, true)).toBe(true);
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
