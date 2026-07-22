import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionConfigSchema } from '../src/config/schema.js';
import type { SessionConfig } from '../src/config/schema.js';
import type { IdentityEndpoints } from '../src/runtimes/types.js';
import { CodexRuntime } from '../src/runtimes/codex/index.js';
import type { CodexRuntimeSettings } from '../src/runtimes/codex/index.js';
import {
  GENERATED_MARKER,
  appendConductorInstructions,
  buildConfigOverrides,
  renderAgentsOverride,
  renderNotifyScript,
  shellQuote,
  tomlString,
} from '../src/runtimes/codex/config-gen.js';

const SETTINGS: CodexRuntimeSettings = { binary: 'codex', toolTimeoutSec: 600 };

function makeSession(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return sessionConfigSchema.parse({ codename: 'sample', repo: '/repos/sample', runtime: 'codex', ...overrides });
}

function makeIdentity(configDir: string): IdentityEndpoints {
  return {
    mcpUrl: 'http://127.0.0.1:3456/mcp/sample',
    eventsUrl: 'http://127.0.0.1:3456/events/sample',
    configDir,
  };
}

describe('config generation', () => {
  it('builds MCP server overrides with URL identity and raised tool timeout', () => {
    const overrides = buildConfigOverrides({
      mcpUrl: 'http://127.0.0.1:3456/mcp/sample',
      notifyCommand: ['/bin/sh', '/cfg/notify.sh'],
      toolTimeoutSec: 600,
      bypassPermissions: true,
      bareUi: false,
    });
    expect(overrides).toContain('mcp_servers.conductor.url="http://127.0.0.1:3456/mcp/sample"');
    expect(overrides).toContain('mcp_servers.conductor.tool_timeout_sec=600');
    expect(overrides).toContain('notify=["/bin/sh","/cfg/notify.sh"]');
    expect(overrides).toContain('approval_policy="never"');
    expect(overrides).toContain('sandbox_mode="danger-full-access"');
    expect(overrides.join(' ')).not.toContain('check_for_update_on_startup');
  });

  it('bareUi strips update prompt, analytics, tips, animations, and title writes', () => {
    const overrides = buildConfigOverrides({
      mcpUrl: 'http://127.0.0.1:3456/mcp/sample',
      notifyCommand: ['/bin/sh', '/cfg/notify.sh'],
      toolTimeoutSec: 600,
      bypassPermissions: true,
      bareUi: true,
    });
    expect(overrides).toContain('check_for_update_on_startup=false');
    expect(overrides).toContain('analytics.enabled=false');
    expect(overrides).toContain('tui.show_tooltips=false');
    expect(overrides).toContain('tui.animations=false');
    expect(overrides).toContain('tui.terminal_title=[]');
  });

  it('bypassPermissions: false drops the approval/sandbox overrides but keeps the correctness ones', () => {
    const overrides = buildConfigOverrides({
      mcpUrl: 'http://127.0.0.1:3456/mcp/sample',
      notifyCommand: ['/bin/sh', '/cfg/notify.sh'],
      toolTimeoutSec: 600,
      bypassPermissions: false,
      bareUi: true,
    });
    expect(overrides.join(' ')).not.toContain('approval_policy');
    expect(overrides.join(' ')).not.toContain('sandbox_mode');
    // Identity + delivery correctness are not permission settings — always on.
    expect(overrides).toContain('disable_paste_burst=true');
    expect(overrides.join(' ')).toContain('mcp_servers.conductor.url');
  });

  it('escapes TOML strings', () => {
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlString('line1\nline2')).toBe('"line1\\nline2"');
  });

  it('shell-quotes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('renders a notify hook that POSTs argv JSON to the events URL', () => {
    const script = renderNotifyScript('http://127.0.0.1:3456/events/sample');
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('payload="$1"');
    expect(script).toContain('--data "$payload"');
    expect(script).toContain("'http://127.0.0.1:3456/events/sample'");
    expect(script).toContain('curl -fsS');
  });

  it('renders AGENTS.override.md embedding the existing AGENTS.md before the protocol', () => {
    const output = renderAgentsOverride('PROTOCOL TEXT', '# Repo rules\nUse tabs.');
    expect(output).toContain(GENERATED_MARKER);
    expect(output).toContain('# Repo rules\nUse tabs.');
    expect(output).toContain('# Conductor protocol');
    expect(output.indexOf('# Repo rules')).toBeLessThan(output.indexOf('# Conductor protocol'));
    expect(output).toContain('PROTOCOL TEXT');
  });

  it('renders AGENTS.override.md without an existing-doc section when there is none', () => {
    const output = renderAgentsOverride('PROTOCOL TEXT', null);
    expect(output).toContain('# Conductor protocol');
    expect(output).not.toContain('undefined');
  });

  it('appends per-session instructions after the protocol when provided', () => {
    const output = renderAgentsOverride('PROTOCOL TEXT', null, 'Be the sentinel.');
    expect(output).toContain('# Session instructions');
    expect(output).toContain('Be the sentinel.');
    expect(output.indexOf('# Conductor protocol')).toBeLessThan(output.indexOf('# Session instructions'));
  });

  it('appends and refreshes one conductor section without replacing existing override instructions', () => {
    const original = '# Existing override\n\nKeep this exactly.';
    const first = appendConductorInstructions(original, 'PROTOCOL ONE');
    const refreshed = appendConductorInstructions(first, 'PROTOCOL TWO', 'Session-specific rule.');

    expect(refreshed).toContain(original);
    expect(refreshed).not.toContain('PROTOCOL ONE');
    expect(refreshed).toContain('PROTOCOL TWO');
    expect(refreshed).toContain('Session-specific rule.');
    expect(refreshed.match(/# Conductor protocol/gu)).toHaveLength(1);
  });
});

describe('buildLaunchCommand', () => {
  const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });
  const identity = makeIdentity('/cfg/sample');

  it('constructs a fresh launch command', () => {
    const cmd = runtime.buildLaunchCommand(makeSession(), identity, { bypassPermissions: true });
    expect(cmd.startsWith("cd '/repos/sample' && export CODEX_HOME='/cfg/sample/codex-home' && 'codex' ")).toBe(true);
    expect(cmd).toContain(`-c 'mcp_servers.conductor.url="http://127.0.0.1:3456/mcp/sample"'`);
    expect(cmd).toContain(`-c 'mcp_servers.conductor.tool_timeout_sec=600'`);
    expect(cmd).toContain(`-c 'notify=["/bin/sh","/cfg/sample/notify.sh"]'`);
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).not.toContain('resume');
    expect(cmd).not.toContain('--model');
    expect(cmd).not.toContain(' -- ');
  });

  it('uses resume --last when continuing a session', () => {
    const cmd = runtime.buildLaunchCommand(makeSession(), identity, {
      continueSession: true,
      bypassPermissions: true,
    });
    expect(cmd).toContain("'codex' resume --last -c ");
    // Config overrides still apply on resume (the bypass flag alone is not honored there).
    expect(cmd).toContain(`-c 'approval_policy="never"'`);
    expect(cmd).toContain(`-c 'sandbox_mode="danger-full-access"'`);
  });

  it('bypassPermissions: false omits the bypass flag and the approval overrides', () => {
    const cmd = runtime.buildLaunchCommand(makeSession(), identity, { bypassPermissions: false });
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).not.toContain('approval_policy');
    expect(cmd).not.toContain('sandbox_mode');
  });

  it('exports a per-session CODEX_HOME so resume --last only sees this session (H4)', () => {
    const cmd = runtime.buildLaunchCommand(makeSession(), identity, { continueSession: true });
    expect(cmd).toContain("export CODEX_HOME='/cfg/sample/codex-home'");
    // The export precedes the binary so the resume reads the isolated sessions dir.
    expect(cmd.indexOf('CODEX_HOME')).toBeLessThan(cmd.indexOf("'codex'"));
  });

  it('passes the initial prompt as a positional argument after --', () => {
    const cmd = runtime.buildLaunchCommand(makeSession(), identity, { prompt: "fix the bug in o'brien.ts" });
    expect(cmd.endsWith(`-- 'fix the bug in o'\\''brien.ts'`)).toBe(true);
  });

  it('combines resume with a follow-up prompt', () => {
    const cmd = runtime.buildLaunchCommand(makeSession(), identity, { continueSession: true, prompt: 'carry on' });
    expect(cmd).toContain('resume --last');
    expect(cmd.endsWith("-- 'carry on'")).toBe(true);
  });

  it('prefers the session model, falling back to the runtime default', () => {
    const withSessionModel = runtime.buildLaunchCommand(makeSession({ model: 'gpt-5.5-codex' }), identity, {});
    expect(withSessionModel).toContain("--model 'gpt-5.5-codex'");

    const defaulted = new CodexRuntime({ config: { ...SETTINGS, defaultModel: 'gpt-5.5' }, baseDir: '/base' });
    expect(defaulted.buildLaunchCommand(makeSession(), identity, {})).toContain("--model 'gpt-5.5'");
  });

  it('maps per-run, session, and fleet effort levels to model_reasoning_effort', () => {
    const defaulted = new CodexRuntime({
      config: { ...SETTINGS, defaultEffort: 'fleet-level' },
      baseDir: '/base',
    });
    expect(defaulted.buildLaunchCommand(makeSession(), identity, {})).toContain(
      `-c 'model_reasoning_effort="fleet-level"'`,
    );
    expect(defaulted.buildLaunchCommand(makeSession({ effort: 'session-level' }), identity, {})).toContain(
      `-c 'model_reasoning_effort="session-level"'`,
    );
    expect(
      defaulted.buildLaunchCommand(makeSession({ effort: 'session-level' }), identity, { effort: 'future-level' }),
    ).toContain(`-c 'model_reasoning_effort="future-level"'`);
  });

  it('grants additional directories via --add-dir and resolves relative paths against baseDir', () => {
    const cmd = runtime.buildLaunchCommand(
      makeSession({ repo: 'repos/sample', additionalDirs: ['/shared/docs', 'sibling'] }),
      identity,
      {},
    );
    expect(cmd.startsWith("cd '/base/repos/sample' && ")).toBe(true);
    expect(cmd).toContain("--add-dir '/shared/docs'");
    expect(cmd).toContain("--add-dir '/base/sibling'");
  });
});

describe('prepare', () => {
  let workDir: string;
  let repoDir: string;
  let configDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'codex-runtime-'));
    repoDir = path.join(workDir, 'repo');
    configDir = path.join(workDir, 'cfg');
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes an executable notify script and a repo AGENTS.override.md with a placeholder protocol', async () => {
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));

    const notifyPath = path.join(configDir, 'notify.sh');
    const notifyStat = await stat(notifyPath);
    expect(notifyStat.mode & 0o100).toBe(0o100);
    expect(await readFile(notifyPath, 'utf8')).toContain('http://127.0.0.1:3456/events/sample');

    const override = await readFile(path.join(repoDir, 'AGENTS.override.md'), 'utf8');
    expect(override).toContain(GENERATED_MARKER);
    expect(override).toContain('conductor protocol placeholder');
    expect(await readFile(path.join(repoDir, '.gitignore'), 'utf8')).toBe('AGENTS.override.md\n');
  });

  it('inlines the protocol file and the repo AGENTS.md when both exist', async () => {
    const protocolPath = path.join(workDir, 'protocol.md');
    await writeFile(protocolPath, 'Report to the conductor via MCP.');
    await writeFile(path.join(repoDir, 'AGENTS.md'), '# House rules');

    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir, protocolPath });
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));

    const override = await readFile(path.join(repoDir, 'AGENTS.override.md'), 'utf8');
    expect(override).toContain('# House rules');
    expect(override).toContain('Report to the conductor via MCP.');
  });

  it('is idempotent and refreshes its own generated override', async () => {
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    const session = makeSession({ repo: repoDir });
    await runtime.prepare(session, makeIdentity(configDir));
    await writeFile(path.join(repoDir, 'AGENTS.md'), '# Added later');
    await runtime.prepare(session, makeIdentity(configDir));

    const override = await readFile(path.join(repoDir, 'AGENTS.override.md'), 'utf8');
    expect(override).toContain('# Added later');
    expect(override.match(/# Conductor protocol/gu)).toHaveLength(1);
    expect(await readFile(path.join(repoDir, '.gitignore'), 'utf8')).toBe('AGENTS.override.md\n');
  });

  it('preserves a tracked AGENTS.override.md and appends the conductor instructions', async () => {
    const overridePath = path.join(repoDir, 'AGENTS.override.md');
    await writeFile(overridePath, '# Hand-written override\n\nKeep this rule.\n');
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['add', 'AGENTS.override.md'], { cwd: repoDir, stdio: 'ignore' });

    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));

    const override = await readFile(overridePath, 'utf8');
    expect(override.startsWith('# Hand-written override\n\nKeep this rule.')).toBe(true);
    expect(override).toContain('# Conductor protocol');
    expect(override.match(/# Conductor protocol/gu)).toHaveLength(1);
    await expect(readFile(path.join(repoDir, '.gitignore'), 'utf8')).rejects.toThrow();
  });

  it('preserves an untracked existing override, appends instructions, and ignores it', async () => {
    const overridePath = path.join(repoDir, 'AGENTS.override.md');
    await writeFile(overridePath, '# Local override\n');
    await writeFile(path.join(repoDir, '.gitignore'), 'dist/');

    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));

    const override = await readFile(overridePath, 'utf8');
    expect(override.startsWith('# Local override')).toBe(true);
    expect(override).toContain('# Conductor protocol');
    expect(await readFile(path.join(repoDir, '.gitignore'), 'utf8')).toBe('dist/\nAGENTS.override.md\n');
  });

  it('recreates a deleted generated override on the next prepare', async () => {
    const overridePath = path.join(repoDir, 'AGENTS.override.md');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    const session = makeSession({ repo: repoDir });
    const identity = makeIdentity(configDir);
    await runtime.prepare(session, identity);
    await rm(overridePath);

    await runtime.prepare(session, identity);

    expect(await readFile(overridePath, 'utf8')).toContain('# Conductor protocol');
  });

  it('creates a per-session CODEX_HOME: auth symlinked, config copied with the repo pre-trusted (H4)', async () => {
    const sharedHome = path.join(workDir, 'shared-codex');
    await mkdir(sharedHome, { recursive: true });
    await writeFile(path.join(sharedHome, 'auth.json'), '{"token":"shared"}');
    await writeFile(path.join(sharedHome, 'config.toml'), 'model = "gpt-5.5"\n');
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sharedHome;
    try {
      const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
      await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));

      const home = path.join(configDir, 'codex-home');
      expect((await stat(home)).isDirectory()).toBe(true);
      // Auth resolves through the symlink; sessions/ stays isolated to this home.
      expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe('{"token":"shared"}');
      // config.toml is a copy (shared config intact) plus the trust entry —
      // Codex only honors folder trust from the config file, and an untrusted
      // dir blocks the pane on an interactive prompt.
      const sessionConfig = await readFile(path.join(home, 'config.toml'), 'utf8');
      expect(sessionConfig).toContain('model = "gpt-5.5"');
      expect(sessionConfig).toContain(`[projects."${repoDir}"]`);
      expect(sessionConfig).toContain('trust_level = "trusted"');
      // The operator's real config was never touched.
      expect(await readFile(path.join(sharedHome, 'config.toml'), 'utf8')).toBe('model = "gpt-5.5"\n');

      // Re-prepare with a shared config that ALREADY trusts the repo: no duplicate table (TOML would reject it).
      await writeFile(
        path.join(sharedHome, 'config.toml'),
        `model = "gpt-5.5"\n[projects."${repoDir}"]\ntrust_level = "trusted"\n`,
      );
      await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));
      const reprepared = await readFile(path.join(home, 'config.toml'), 'utf8');
      expect(reprepared.split(`[projects."${repoDir}"]`).length - 1).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });

  it('tolerates a shared home with no auth.json (env-var auth)', async () => {
    const sharedHome = path.join(workDir, 'empty-codex');
    await mkdir(sharedHome, { recursive: true });
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sharedHome;
    try {
      const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
      await expect(runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir))).resolves.toBeUndefined();
      expect((await stat(path.join(configDir, 'codex-home'))).isDirectory()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});

describe('parseEvent', () => {
  const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });

  it('maps agent-turn-complete to a stop event carrying the last assistant message', () => {
    const event = runtime.parseEvent({
      'type': 'agent-turn-complete',
      'turn-id': 'abc123',
      'input-messages': ['Run tests'],
      'last-assistant-message': 'All tests passed',
    });
    expect(event).toEqual({ type: 'stop', reason: 'All tests passed', transcriptPath: undefined });
  });

  it('tolerates a missing last-assistant-message', () => {
    const event = runtime.parseEvent({ 'type': 'agent-turn-complete', 'turn-id': 'abc123' });
    expect(event).toEqual({ type: 'stop', reason: undefined, transcriptPath: undefined });
  });

  it('returns null for unknown event types and malformed bodies', () => {
    expect(runtime.parseEvent({ type: 'session-turn-start' })).toBeNull();
    expect(runtime.parseEvent({ type: 42 })).toBeNull();
    expect(runtime.parseEvent('agent-turn-complete')).toBeNull();
    expect(runtime.parseEvent(null)).toBeNull();
    expect(runtime.parseEvent(['agent-turn-complete'])).toBeNull();
  });
});

describe('parseInputState', () => {
  const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });

  it('reports clear for an empty composer row', () => {
    expect(runtime.parseInputState('some output\n\n› \n  ⏎ send   Ctrl+J newline')).toBe('clear');
  });

  it('blocks on all non-empty plain-text composer content', () => {
    const fresh = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });
    // iTerm strips the dim styling that identifies placeholders, so safety
    // requires treating even suggestion-shaped plain text as occupied input.
    expect(fresh.parseInputState('› Use /skills to list available skills', 'alpha')).toBe('draft');
    expect(fresh.parseInputState('› Explain this codebase', 'alpha')).toBe('draft');
    expect(fresh.parseInputState('› refactor the parser', 'alpha')).toBe('draft');
    expect(fresh.parseInputState('› my half-typed operator draft', 'beta')).toBe('draft');
    expect(fresh.parseInputState('› ', 'alpha')).toBe('clear');
  });

  it('reports an operator draft for non-empty content when no session is given', () => {
    expect(runtime.parseInputState('output\n› refactor the parser\n⏎ send')).toBe('draft');
  });

  it('returns null when no composer row is visible', () => {
    expect(runtime.parseInputState('plain shell output\n$ ')).toBeNull();
    expect(runtime.parseInputState('')).toBeNull();
  });

  it('conservatively blocks on plain envelope rows whose composer status is ambiguous', () => {
    // Plain iTerm capture cannot prove whether a › envelope row is submitted
    // history or occupied input. The safe result is draft in both cases.
    expect(runtime.parseInputState('output\n› [Message from operator] MSG-ONE-111\n\n  model med · /repo')).toBe(
      'draft',
    );
    expect(runtime.parseInputState('› [Broadcast from alpha] heads up', 'x')).toBe('draft');
  });

  it('sees the composer through footer and hint chrome below it', () => {
    const capture = '› \n  ⏎ send   ⌃J newline\n  gpt-5.6 medium · /repo\n';
    expect(runtime.parseInputState(capture)).toBe('clear');
  });

  it('returns null when the bottom content row is transcript, not the composer', () => {
    // A delivered-but-unechoed message line sits between the last ›-row and
    // the footer — the composer is not visible in this state.
    const capture = '› [Message from operator] one\n  [Message from operator] two\n\n  gpt-5.6 medium · /repo\n';
    expect(runtime.parseInputState(capture, 'y')).toBeNull();
  });
});

describe('parseInputState — styled captures (tmux -e)', () => {
  // Byte-for-byte from a live `tmux capture-pane -e` of Codex 0.144.x:
  // composer glyph is bold, transcript glyph bold+dim, ghost hint dim.
  const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });
  const BOLD_GLYPH = '\u001b[1m›\u001b[0m';

  it('detects the dim ghost hint as an EMPTY composer — no learning involved', () => {
    const capture = `${BOLD_GLYPH} \u001b[2mImplement {feature}\u001b[0m`;
    // Styling proves this is a placeholder rather than actual input.
    expect(runtime.parseInputState(capture)).toBe('clear');
  });

  it('classifies unstyled content as an operator draft', () => {
    expect(runtime.parseInputState(`${BOLD_GLYPH} hello this is my draft`, 'alpha')).toBe('draft');
  });

  it('never learns operator text as a ghost hint (the restart-clobber bug)', () => {
    const fresh = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });
    // A restarted conductor sees the operator's draft FIRST — with styling it
    // must classify, not learn.
    expect(fresh.parseInputState(`${BOLD_GLYPH} my precious draft`, 'alpha')).toBe('draft');
    // …and the real ghost hint later is still recognized as clear.
    expect(fresh.parseInputState(`${BOLD_GLYPH} \u001b[2mImplement {feature}\u001b[0m`, 'alpha')).toBe('clear');
    // …and the draft is STILL an operator draft afterwards.
    expect(fresh.parseInputState(`${BOLD_GLYPH} my precious draft`, 'alpha')).toBe('draft');
  });

  it('treats a signed conductor envelope as an ordinary draft', () => {
    const capture = `${BOLD_GLYPH} [Message from operator] test envelope`;
    expect(runtime.parseInputState(capture, 'alpha')).toBe('draft');
  });

  it('treats a dim-glyph ›-row as transcript history (composer hidden)', () => {
    const capture = '\u001b[1;2m› \u001b[0m[Message from operator] test envelope';
    expect(runtime.parseInputState(capture, 'alpha')).toBeNull();
  });

  it('reports clear for an empty styled composer', () => {
    expect(runtime.parseInputState(`${BOLD_GLYPH} \n  \u001b[2m⏎ send\u001b[0m`, 'alpha')).toBe('clear');
  });

  it('does not mistake extended-color components for the dim attribute', () => {
    // 38;5;2 is a green FOREGROUND, not dim — this is typed text.
    const capture = `${BOLD_GLYPH} \u001b[38;5;2mgreen typed text\u001b[0m`;
    expect(runtime.parseInputState(capture, 'alpha')).toBe('draft');
  });
});

describe('stripChrome', () => {
  const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });

  it('removes composer, hints, context meter, and spinner rows but keeps content', () => {
    const capture = [
      'I updated the parser and reran the suite.',
      'All 42 tests pass.',
      '',
      '• Working (3s • esc to interrupt)',
      '› ',
      '  ⏎ send   Ctrl+J newline   ⌃T transcript   ⌃C quit',
      '  97% context left',
    ].join('\n');
    expect(runtime.stripChrome(capture)).toBe('I updated the parser and reran the suite.\nAll 42 tests pass.');
  });

  it('leaves ordinary output untouched', () => {
    const capture = 'line one\nline two';
    expect(runtime.stripChrome(capture)).toBe(capture);
  });
});

describe('readLastAssistantMessage', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'codex-rollout-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns the last assistant message from a rollout JSONL transcript', async () => {
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    const transcript = path.join(workDir, 'rollout-2026-07-14T10-00-00-abc.jsonl');
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'abc' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run tests' }] },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First reply' }] },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All tests passed' }] },
      }),
      'not-json',
    ];
    await writeFile(transcript, `${lines.join('\n')}\n`);
    await expect(runtime.readLastAssistantMessage(transcript)).resolves.toBe('All tests passed');
  });

  it('returns null for a missing file or a transcript with no assistant messages', async () => {
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await expect(runtime.readLastAssistantMessage(path.join(workDir, 'missing.jsonl'))).resolves.toBeNull();

    const empty = path.join(workDir, 'empty.jsonl');
    await writeFile(empty, `${JSON.stringify({ type: 'session_meta', payload: {} })}\n`);
    await expect(runtime.readLastAssistantMessage(empty)).resolves.toBeNull();
  });
});
