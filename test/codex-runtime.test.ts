import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionConfigSchema } from '../src/config/schema.js';
import type { SessionConfig } from '../src/config/schema.js';
import type { IdentityEndpoints } from '../src/runtimes/types.js';
import { MAX_SESSION_INSTRUCTION_BYTES } from '../src/runtimes/instructions.js';
import { CodexRuntime } from '../src/runtimes/codex/index.js';
import type { CodexRuntimeSettings } from '../src/runtimes/codex/index.js';
import {
  GENERATED_MARKER,
  appendConductorInstructions,
  buildConfigOverrides,
  ensureProjectDocMaxBytes,
  readProjectDocMaxBytes,
  renderAgentsOverride,
  renderHomeAgentsOverride,
  renderLifecycleHookScript,
  renderNotifyScript,
  renderProtocolHooks,
  renderProtocolReminderScript,
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

  it('renders one compact restoration with distinct protocol/session layers and an independent lifecycle relay', () => {
    const script = renderProtocolReminderScript(
      'Use send_to_session for READY signals.\n',
      'Review every change before reporting.\n',
    );
    const hooks = JSON.parse(
      renderProtocolHooks("'/usr/bin/node' '/cfg/protocol-reminder.mjs'", "'/usr/bin/node' '/cfg/lifecycle-hook.mjs'"),
    ) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    expect(script).toContain('hookEventName');
    expect(script).toContain('Use send_to_session for READY signals.');
    expect(script).toContain('Review every change before reporting.');
    expect(script).not.toContain('curl');
    expect(hooks.hooks.SessionStart[0]?.matcher).toBe('^compact$');
    expect(hooks.hooks.SessionStart[0]?.hooks[0]?.command).toContain('protocol-reminder.mjs');
    expect(hooks.hooks.SessionStart[0]?.hooks[1]?.command).toContain('lifecycle-hook.mjs');
    expect(hooks.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toContain('lifecycle-hook.mjs');
    expect(hooks.hooks.PreCompact[0]?.hooks[0]?.command).toContain('lifecycle-hook.mjs');
    expect(JSON.stringify(hooks)).not.toContain('PostCompact');
  });

  it('keeps the shipped protocol plus the largest valid session layer inside provider hook limits', async () => {
    const protocol = await readFile(path.resolve('prompts/conductor-protocol.md'), 'utf8');
    const largestValidSession = `${'x'.repeat(MAX_SESSION_INSTRUCTION_BYTES - 1)}\n`;
    expect(() => renderProtocolReminderScript(protocol, largestValidSession)).not.toThrow();
  });

  it('renders a lifecycle relay that forwards hook stdin without exposing it on stdout', () => {
    const script = renderLifecycleHookScript('http://127.0.0.1:3456/events/sample');
    expect(script).toContain("execFileSync('curl'");
    expect(script).toContain("'--data-binary', '@-'");
    expect(script).toContain('http://127.0.0.1:3456/events/sample');
    expect(script).not.toContain('process.stdout.write');
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

  it('composes home guidance before mandatory protocol and session instructions', () => {
    const rendered = renderHomeAgentsOverride('GLOBAL RULE', 'PROTOCOL TEXT', 'SESSION RULE').content;
    expect(rendered.indexOf('GLOBAL RULE')).toBeLessThan(rendered.indexOf('PROTOCOL TEXT'));
    expect(rendered.indexOf('PROTOCOL TEXT')).toBeLessThan(rendered.indexOf('SESSION RULE'));
  });

  it('bounds only inherited guidance and keeps mandatory instructions intact', () => {
    const rendered = renderHomeAgentsOverride('abcdefghijk', 'PROTOCOL TEXT', 'SESSION RULE', 5);
    expect(rendered.inheritedGuidanceTruncated).toBe(true);
    expect(rendered.content).toContain('abcde');
    expect(rendered.content).not.toContain('abcdefghijk');
    expect(rendered.content).toContain('PROTOCOL TEXT');
    expect(rendered.content).toContain('SESSION RULE');
    expect(rendered.content).toContain('shortened inherited global guidance');
  });

  it('raises only the top-level project_doc_max_bytes while preserving larger values and tables', () => {
    const source = 'model = "test"\nproject_doc_max_bytes = 1_000 # operator value\n\n[tui]\nanimations = false\n';
    const raised = ensureProjectDocMaxBytes(source, 2_000);
    expect(raised).toContain('project_doc_max_bytes = 2000 # operator value');
    expect(raised).toContain('[tui]\nanimations = false');
    expect(readProjectDocMaxBytes(raised)).toBe(2000);
    expect(ensureProjectDocMaxBytes(raised, 1_500)).toBe(raised);
  });

  it('inserts a missing document limit before the first TOML table', () => {
    const result = ensureProjectDocMaxBytes('[tui]\nproject_doc_max_bytes = 7\n', 1234);
    expect(result.indexOf('project_doc_max_bytes = 1234')).toBeLessThan(result.indexOf('[tui]'));
    expect(result).toContain('[tui]\nproject_doc_max_bytes = 7');
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
  let sharedHome: string;
  let previousCodexHome: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'codex-runtime-'));
    repoDir = path.join(workDir, 'repo');
    configDir = path.join(workDir, 'cfg');
    sharedHome = path.join(workDir, 'shared-codex');
    await mkdir(repoDir, { recursive: true });
    await mkdir(sharedHome, { recursive: true });
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sharedHome;
  });

  afterEach(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes the notify hook and placeholder protocol inside the per-session home only', async () => {
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));

    const notifyPath = path.join(configDir, 'notify.sh');
    const notifyStat = await stat(notifyPath);
    expect(notifyStat.mode & 0o777).toBe(0o700);
    expect(await readFile(notifyPath, 'utf8')).toContain('http://127.0.0.1:3456/events/sample');

    const overridePath = path.join(configDir, 'codex-home', 'AGENTS.override.md');
    const override = await readFile(overridePath, 'utf8');
    expect((await stat(overridePath)).mode & 0o777).toBe(0o600);
    expect(override).toContain(GENERATED_MARKER);
    expect(override).toContain('conductor protocol placeholder');
    const hooks = await readFile(path.join(configDir, 'codex-home', 'hooks.json'), 'utf8');
    expect(hooks).toContain('^compact$');
    expect(hooks).toContain('UserPromptSubmit');
    expect(hooks).toContain('PreCompact');
    const lifecycleHookPath = path.join(configDir, 'lifecycle-hook.mjs');
    expect((await stat(lifecycleHookPath)).mode & 0o777).toBe(0o700);
    const lifecycleHook = await readFile(lifecycleHookPath, 'utf8');
    expect(lifecycleHook).toContain('http://127.0.0.1:3456/events/sample');
    const fakeBin = path.join(workDir, 'fake-bin');
    const relayedPayload = path.join(workDir, 'relayed-hook.json');
    await mkdir(fakeBin);
    await writeFile(path.join(fakeBin, 'curl'), '#!/bin/sh\ncat > "$HOOK_CAPTURE_PATH"\n', { mode: 0o755 });
    execFileSync(process.execPath, [lifecycleHookPath], {
      input: '{"hook_event_name":"UserPromptSubmit"}',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, HOOK_CAPTURE_PATH: relayedPayload },
    });
    expect(await readFile(relayedPayload, 'utf8')).toBe('{"hook_event_name":"UserPromptSubmit"}');
    const reminder = await readFile(path.join(configDir, 'protocol-reminder.mjs'), 'utf8');
    expect((await stat(path.join(configDir, 'protocol-reminder.mjs'))).mode & 0o777).toBe(0o700);
    expect(reminder).toContain('conductor protocol placeholder');
    const reminderOutput = JSON.parse(
      execFileSync(process.execPath, [path.join(configDir, 'protocol-reminder.mjs')], { encoding: 'utf8' }),
    ) as { hookSpecificOutput: { hookEventName: unknown; additionalContext: string } };
    expect(reminderOutput.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(reminderOutput.hookSpecificOutput.additionalContext).toContain('conductor protocol placeholder');
    await expect(readFile(path.join(repoDir, 'AGENTS.override.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(repoDir, '.gitignore'), 'utf8')).rejects.toThrow();
  });

  it('restores the prepared session snapshot after compact and refreshes it only on prepare', async () => {
    const protocolPath = path.join(workDir, 'protocol.md');
    const promptPath = path.join(workDir, 'session.md');
    await writeFile(protocolPath, 'PROTOCOL LAYER');
    await writeFile(promptPath, 'SESSION VERSION ONE');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir, protocolPath });
    const configured = makeSession({ repo: repoDir, systemPromptFile: promptPath });
    await runtime.prepare(configured, makeIdentity(configDir));

    const reminderPath = path.join(configDir, 'protocol-reminder.mjs');
    const context = (): string => {
      const output = JSON.parse(execFileSync(process.execPath, [reminderPath], { encoding: 'utf8' })) as {
        hookSpecificOutput: { additionalContext: string };
      };
      return output.hookSpecificOutput.additionalContext;
    };
    expect(context()).toContain('PROTOCOL LAYER\n');
    expect(context()).toContain('SESSION VERSION ONE\n');

    await writeFile(promptPath, 'SESSION VERSION TWO');
    expect(context()).toContain('SESSION VERSION ONE\n');
    expect(context()).not.toContain('SESSION VERSION TWO');

    await runtime.prepare(configured, makeIdentity(configDir));
    expect(context()).toContain('SESSION VERSION TWO\n');
    expect(context()).not.toContain('SESSION VERSION ONE');
  });

  it('preserves known-good snapshots when aggregate compact context validation fails', async () => {
    const protocolPath = path.join(workDir, 'protocol.md');
    const promptPath = path.join(workDir, 'session.md');
    await writeFile(protocolPath, 'KNOWN GOOD PROTOCOL');
    await writeFile(promptPath, 'KNOWN GOOD SESSION');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir, protocolPath });
    const configured = makeSession({ repo: repoDir, systemPromptFile: promptPath });
    await runtime.prepare(configured, makeIdentity(configDir));

    await writeFile(protocolPath, 'x'.repeat(10_001));
    await expect(runtime.prepare(configured, makeIdentity(configDir))).rejects.toThrow(
      /compact-restoration context is too large/u,
    );
    expect(await readFile(path.join(configDir, 'conductor-protocol.md'), 'utf8')).toBe('KNOWN GOOD PROTOCOL\n');
    expect(await readFile(path.join(configDir, 'session-instructions.md'), 'utf8')).toBe('KNOWN GOOD SESSION\n');
  });

  it('atomically replaces legacy context files with restrictive permissions', async () => {
    const protocolPath = path.join(workDir, 'protocol.md');
    const promptPath = path.join(workDir, 'session.md');
    await writeFile(protocolPath, 'PRIVATE PROTOCOL');
    await writeFile(promptPath, 'PRIVATE SESSION');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir, protocolPath });
    const configured = makeSession({ repo: repoDir, systemPromptFile: promptPath });
    await runtime.prepare(configured, makeIdentity(configDir));

    const overridePath = path.join(configDir, 'codex-home', 'AGENTS.override.md');
    const reminderPath = path.join(configDir, 'protocol-reminder.mjs');
    await chmod(overridePath, 0o644);
    await chmod(reminderPath, 0o755);
    await writeFile(promptPath, 'REFRESHED PRIVATE SESSION');
    await runtime.prepare(configured, makeIdentity(configDir));

    expect((await stat(overridePath)).mode & 0o777).toBe(0o600);
    expect((await stat(reminderPath)).mode & 0o777).toBe(0o700);
    expect(await readFile(overridePath, 'utf8')).toContain('REFRESHED PRIVATE SESSION');
    expect(await readFile(reminderPath, 'utf8')).toContain('REFRESHED PRIVATE SESSION');
  });

  it('adds the hook-trust bypass flag only when configured true', () => {
    const safe = new CodexRuntime({ config: { ...SETTINGS, bypassHookTrust: false }, baseDir: workDir });
    const trusted = new CodexRuntime({ config: { ...SETTINGS, bypassHookTrust: true }, baseDir: workDir });
    const session = makeSession();
    const identity = makeIdentity(configDir);
    expect(safe.buildLaunchCommand(session, identity, {})).not.toContain('--dangerously-bypass-hook-trust');
    expect(trusted.buildLaunchCommand(session, identity, {})).toContain('--dangerously-bypass-hook-trust');
  });

  it('inherits a non-empty global override before protocol and session instructions', async () => {
    const protocolPath = path.join(workDir, 'protocol.md');
    const promptPath = path.join(workDir, 'session.md');
    await writeFile(protocolPath, 'Report to the conductor via MCP.');
    await writeFile(promptPath, 'Act as the reviewer.');
    await writeFile(path.join(sharedHome, 'AGENTS.override.md'), '# Global override');
    await writeFile(path.join(sharedHome, 'AGENTS.md'), '# Lower-priority global file');

    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir, protocolPath });
    await runtime.prepare(makeSession({ repo: repoDir, systemPromptFile: promptPath }), makeIdentity(configDir));

    const override = await readFile(path.join(configDir, 'codex-home', 'AGENTS.override.md'), 'utf8');
    expect(override).toContain('# Global override');
    expect(override).not.toContain('Lower-priority');
    expect(override).toContain('Report to the conductor via MCP.');
    expect(override).toContain('Act as the reviewer.');
    expect(override.indexOf('# Global override')).toBeLessThan(override.indexOf('Report to the conductor'));
    expect(override.indexOf('Report to the conductor')).toBeLessThan(override.indexOf('Act as the reviewer'));
  });

  it('falls back from an empty global override to the shared AGENTS.md', async () => {
    await writeFile(path.join(sharedHome, 'AGENTS.override.md'), ' \n');
    await writeFile(path.join(sharedHome, 'AGENTS.md'), '# Global fallback');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));
    expect(await readFile(path.join(configDir, 'codex-home', 'AGENTS.override.md'), 'utf8')).toContain(
      '# Global fallback',
    );
  });

  it('removes only the managed block from a tracked legacy repository override', async () => {
    const overridePath = path.join(repoDir, 'AGENTS.override.md');
    const legacy = appendConductorInstructions('# Hand-written override\n\nKeep this rule.', 'OLD PROTOCOL');
    await writeFile(overridePath, legacy);
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['add', 'AGENTS.override.md'], { cwd: repoDir, stdio: 'ignore' });

    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));

    const override = await readFile(overridePath, 'utf8');
    expect(override.startsWith('# Hand-written override\n\nKeep this rule.')).toBe(true);
    expect(override).not.toContain('OLD PROTOCOL');
    expect(override).not.toContain('instructions begin');
    await expect(readFile(path.join(repoDir, '.gitignore'), 'utf8')).rejects.toThrow();
  });

  it('deletes an untracked legacy file generated entirely by Conductor', async () => {
    const overridePath = path.join(repoDir, 'AGENTS.override.md');
    await writeFile(overridePath, renderAgentsOverride('OLD PROTOCOL', '# Former embedded repo rules'));

    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));

    await expect(readFile(overridePath, 'utf8')).rejects.toThrow();
  });

  it('leaves an unmarked repository override and existing .gitignore untouched', async () => {
    const overridePath = path.join(repoDir, 'AGENTS.override.md');
    await writeFile(overridePath, '# User-owned override\n');
    await writeFile(path.join(repoDir, '.gitignore'), 'dist/\nAGENTS.override.md\n');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));
    await runtime.prepare(makeSession({ repo: repoDir }), makeIdentity(configDir));
    expect(await readFile(overridePath, 'utf8')).toBe('# User-owned override\n');
    expect(await readFile(path.join(repoDir, '.gitignore'), 'utf8')).toBe('dist/\nAGENTS.override.md\n');
  });

  it('keeps session instructions distinct for two sessions sharing one repository', async () => {
    const firstPrompt = path.join(workDir, 'first.md');
    const secondPrompt = path.join(workDir, 'second.md');
    await writeFile(firstPrompt, 'FIRST SESSION ONLY');
    await writeFile(secondPrompt, 'SECOND SESSION ONLY');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    const firstConfig = path.join(workDir, 'first-config');
    const secondConfig = path.join(workDir, 'second-config');

    await runtime.prepare(
      makeSession({ codename: 'first', repo: repoDir, systemPromptFile: firstPrompt }),
      makeIdentity(firstConfig),
    );
    await runtime.prepare(
      makeSession({ codename: 'second', repo: repoDir, systemPromptFile: secondPrompt }),
      makeIdentity(secondConfig),
    );

    const first = await readFile(path.join(firstConfig, 'codex-home', 'AGENTS.override.md'), 'utf8');
    const second = await readFile(path.join(secondConfig, 'codex-home', 'AGENTS.override.md'), 'utf8');
    expect(first).toContain('FIRST SESSION ONLY');
    expect(first).not.toContain('SECOND SESSION ONLY');
    expect(second).toContain('SECOND SESSION ONLY');
    expect(second).not.toContain('FIRST SESSION ONLY');
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
      const generatedOverride = await readFile(path.join(home, 'AGENTS.override.md'), 'utf8');
      expect(readProjectDocMaxBytes(sessionConfig)).toBeGreaterThan(Buffer.byteLength(generatedOverride, 'utf8'));
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
    expect(event).toEqual({
      type: 'stop',
      turnId: 'abc123',
      reason: 'All tests passed',
      transcriptPath: undefined,
    });
  });

  it('maps trusted lifecycle-hook payloads to prompt start, compaction, and compact restart', () => {
    expect(runtime.parseEvent({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' })).toEqual({
      type: 'turn-start',
      turnId: 'turn-1',
    });
    expect(runtime.parseEvent({ hook_event_name: 'PreCompact', transcript_path: '/tmp/rollout.jsonl' })).toEqual({
      type: 'compaction',
      transcriptPath: '/tmp/rollout.jsonl',
    });
    expect(runtime.parseEvent({ hook_event_name: 'SessionStart', source: 'compact' })).toEqual({
      type: 'compaction-complete',
    });
    expect(runtime.parseEvent({ hook_event_name: 'SessionStart', source: 'startup' })).toEqual({
      type: 'session-start',
    });
  });

  it('tolerates a missing last-assistant-message', () => {
    const event = runtime.parseEvent({ 'type': 'agent-turn-complete', 'turn-id': 'abc123' });
    expect(event).toEqual({ type: 'stop', turnId: 'abc123', reason: undefined, transcriptPath: undefined });
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

  it('recognizes exact built-in plain-text ghost hints without learning arbitrary content', () => {
    const fresh = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });
    // iTerm strips the dim styling that identifies placeholders, so safety
    // requires an explicit finite pool rather than learning first-seen text.
    expect(fresh.parseInputState("› What's on your mind?", 'alpha')).toBe('clear');
    expect(fresh.parseInputState('› Use /skills to list available skills', 'alpha')).toBe('clear');
    expect(fresh.parseInputState('› Explain this codebase', 'alpha')).toBe('clear');
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

describe('parseActivityState', () => {
  const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });

  it('keeps an active turn working even when Codex also renders a composer', () => {
    const capture = ['• Working (3s)', "› What's on your mind?", '  gpt-5.6 medium · /repo'].join('\n');
    expect(runtime.parseInputState(capture, 'alpha')).toBe('clear');
    expect(runtime.parseActivityState(capture, 'alpha')).toBe('working');
  });

  it('reports idle only from a visible composer without execution evidence', () => {
    expect(runtime.parseActivityState("completed output\n› What's on your mind?", 'alpha')).toBe('idle');
    expect(runtime.parseActivityState('output without runtime chrome', 'alpha')).toBe('unknown');
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

describe('resolveInputState — plain iTerm transcript evidence', () => {
  let workDir: string;
  let rolloutDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'codex-input-evidence-'));
    rolloutDir = path.join(workDir, 'alpha', 'codex-home', 'sessions', '2026', '07', '23');
    await mkdir(rolloutDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('releases an aborted submitted row that remains at the bottom of an idle Codex pane', async () => {
    const submitted =
      '[Message from beta] Ack: inbound works. My outbound direct-message path is still broken; inspect /workspace/projects/alpha.';
    await writeInputRollout(submitted, 'turn_aborted');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base', sessionDataDir: workDir });
    const capture = [
      '› [Message from beta] Ack: inbound works. My outbound direct-',
      '  message path is still broken; inspect /workspace/',
      '  projects/alpha.',
      '',
      '  codex-test high · Context 42% used · alpha',
    ].join('\n');
    const parsed = runtime.parseInputState(capture, 'alpha');

    expect(parsed).toBeNull();
    await expect(runtime.resolveInputState(capture, 'alpha', parsed)).resolves.toBe('clear');
  });

  it('releases the submitted suffix when terminal wrapping pushes the prompt glyph outside the capture', async () => {
    const submitted =
      '[Message from beta] This deliberately long submitted message has a unique ending that remains visible after the leading prompt and earlier wrapped rows scroll outside the ten-line delivery capture.';
    await writeInputRollout(submitted, 'turn_aborted');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base', sessionDataDir: workDir });
    const capture = [
      '  unique ending that remains visible after the leading prompt and earlier wrapped rows',
      '  scroll outside the ten-line delivery capture.',
      '',
      '  codex-test high · Context 42% used · alpha',
    ].join('\n');
    const parsed = runtime.parseInputState(capture, 'alpha');

    expect(parsed).toBeNull();
    await expect(runtime.resolveInputState(capture, 'alpha', parsed)).resolves.toBe('clear');
  });

  it('does not release matching submitted text while its turn is still active', async () => {
    const submitted = '[Message from operator] investigate the delivery queue';
    await writeInputRollout(submitted, 'task_started');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base', sessionDataDir: workDir });
    const capture = `› ${submitted}\n  codex-test high · alpha`;
    const parsed = runtime.parseInputState(capture, 'alpha');

    expect(parsed).toBe('draft');
    await expect(runtime.resolveInputState(capture, 'alpha', parsed)).resolves.toBe('draft');
  });

  it('keeps an unrelated operator draft blocked after the previous turn ended', async () => {
    await writeInputRollout('[Message from operator] previous submitted text', 'task_complete');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base', sessionDataDir: workDir });
    const capture = '› my precious unsent operator draft\n  codex-test high · alpha';
    const parsed = runtime.parseInputState(capture, 'alpha');

    expect(parsed).toBe('draft');
    await expect(runtime.resolveInputState(capture, 'alpha', parsed)).resolves.toBe('draft');
  });

  it('keeps a glyph-less multiline operator draft blocked after the previous turn ended', async () => {
    await writeInputRollout('[Message from operator] previous submitted text', 'task_complete');
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base', sessionDataDir: workDir });
    const capture = [
      '  continuation of my precious unsent operator draft',
      '  with enough text to push its prompt glyph outside capture',
      '  codex-test high · alpha',
    ].join('\n');
    const parsed = runtime.parseInputState(capture, 'alpha');

    expect(parsed).toBeNull();
    await expect(runtime.resolveInputState(capture, 'alpha', parsed)).resolves.toBeNull();
  });

  async function writeInputRollout(message: string, finalEvent: 'task_started' | 'task_complete' | 'turn_aborted') {
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] },
      }),
      ...(finalEvent === 'task_started' ? [] : [JSON.stringify({ type: 'event_msg', payload: { type: finalEvent } })]),
    ];
    await writeFile(path.join(rolloutDir, 'rollout-2026-07-23T03-27-52-test.jsonl'), `${lines.join('\n')}\n`);
  }
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
