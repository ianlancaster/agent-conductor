import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentConfigSchema } from '../src/config/schema.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { IdentityEndpoints } from '../src/runtimes/types.js';
import { CodexRuntime } from '../src/runtimes/codex/index.js';
import type { CodexRuntimeSettings } from '../src/runtimes/codex/index.js';
import {
  GENERATED_MARKER,
  buildConfigOverrides,
  renderAgentsOverride,
  renderNotifyScript,
  shellQuote,
  tomlString,
} from '../src/runtimes/codex/config-gen.js';

const SETTINGS: CodexRuntimeSettings = { binary: 'codex', toolTimeoutSec: 600 };

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return agentConfigSchema.parse({ codename: 'midgard', repo: '/repos/midgard', runtime: 'codex', ...overrides });
}

function makeIdentity(configDir: string): IdentityEndpoints {
  return {
    mcpUrl: 'http://127.0.0.1:3456/mcp/midgard',
    eventsUrl: 'http://127.0.0.1:3456/events/midgard',
    configDir,
  };
}

describe('config generation', () => {
  it('builds MCP server overrides with URL identity and raised tool timeout', () => {
    const overrides = buildConfigOverrides({
      mcpUrl: 'http://127.0.0.1:3456/mcp/midgard',
      notifyCommand: ['/bin/sh', '/cfg/notify.sh'],
      toolTimeoutSec: 600,
    });
    expect(overrides).toContain('mcp_servers.conductor.url="http://127.0.0.1:3456/mcp/midgard"');
    expect(overrides).toContain('mcp_servers.conductor.tool_timeout_sec=600');
    expect(overrides).toContain('notify=["/bin/sh","/cfg/notify.sh"]');
    expect(overrides).toContain('approval_policy="never"');
    expect(overrides).toContain('sandbox_mode="danger-full-access"');
  });

  it('escapes TOML strings', () => {
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlString('line1\nline2')).toBe('"line1\\nline2"');
  });

  it('shell-quotes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('renders a notify hook that POSTs argv JSON to the events URL', () => {
    const script = renderNotifyScript('http://127.0.0.1:3456/events/midgard');
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('payload="$1"');
    expect(script).toContain('--data "$payload"');
    expect(script).toContain("'http://127.0.0.1:3456/events/midgard'");
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

  it('appends per-agent instructions after the protocol when provided', () => {
    const output = renderAgentsOverride('PROTOCOL TEXT', null, 'Be the sentinel.');
    expect(output).toContain('# Agent instructions');
    expect(output).toContain('Be the sentinel.');
    expect(output.indexOf('# Conductor protocol')).toBeLessThan(output.indexOf('# Agent instructions'));
  });
});

describe('buildLaunchCommand', () => {
  const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });
  const identity = makeIdentity('/cfg/midgard');

  it('constructs a fresh launch command', () => {
    const cmd = runtime.buildLaunchCommand(makeAgent(), identity, {});
    expect(cmd.startsWith("cd '/repos/midgard' && export CODEX_HOME='/cfg/midgard/codex-home' && 'codex' ")).toBe(true);
    expect(cmd).toContain(`-c 'mcp_servers.conductor.url="http://127.0.0.1:3456/mcp/midgard"'`);
    expect(cmd).toContain(`-c 'mcp_servers.conductor.tool_timeout_sec=600'`);
    expect(cmd).toContain(`-c 'notify=["/bin/sh","/cfg/midgard/notify.sh"]'`);
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).not.toContain('resume');
    expect(cmd).not.toContain('--model');
    expect(cmd).not.toContain(' -- ');
  });

  it('uses resume --last when continuing a session', () => {
    const cmd = runtime.buildLaunchCommand(makeAgent(), identity, { continueSession: true });
    expect(cmd).toContain("'codex' resume --last -c ");
    // Config overrides still apply on resume (the bypass flag alone is not honored there).
    expect(cmd).toContain(`-c 'approval_policy="never"'`);
    expect(cmd).toContain(`-c 'sandbox_mode="danger-full-access"'`);
  });

  it('exports a per-agent CODEX_HOME so resume --last only sees this agent (H4)', () => {
    const cmd = runtime.buildLaunchCommand(makeAgent(), identity, { continueSession: true });
    expect(cmd).toContain("export CODEX_HOME='/cfg/midgard/codex-home'");
    // The export precedes the binary so the resume reads the isolated sessions dir.
    expect(cmd.indexOf('CODEX_HOME')).toBeLessThan(cmd.indexOf("'codex'"));
  });

  it('passes the initial prompt as a positional argument after --', () => {
    const cmd = runtime.buildLaunchCommand(makeAgent(), identity, { prompt: "fix the bug in o'brien.ts" });
    expect(cmd.endsWith(`-- 'fix the bug in o'\\''brien.ts'`)).toBe(true);
  });

  it('combines resume with a follow-up prompt', () => {
    const cmd = runtime.buildLaunchCommand(makeAgent(), identity, { continueSession: true, prompt: 'carry on' });
    expect(cmd).toContain('resume --last');
    expect(cmd.endsWith("-- 'carry on'")).toBe(true);
  });

  it('prefers the agent model, falling back to the runtime default', () => {
    const withAgentModel = runtime.buildLaunchCommand(makeAgent({ model: 'gpt-5.5-codex' }), identity, {});
    expect(withAgentModel).toContain("--model 'gpt-5.5-codex'");

    const defaulted = new CodexRuntime({ config: { ...SETTINGS, defaultModel: 'gpt-5.5' }, baseDir: '/base' });
    expect(defaulted.buildLaunchCommand(makeAgent(), identity, {})).toContain("--model 'gpt-5.5'");
  });

  it('grants additional directories via --add-dir and resolves relative paths against baseDir', () => {
    const cmd = runtime.buildLaunchCommand(
      makeAgent({ repo: 'repos/midgard', additionalDirs: ['/shared/docs', 'sibling'] }),
      identity,
      {},
    );
    expect(cmd.startsWith("cd '/base/repos/midgard' && ")).toBe(true);
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
    await runtime.prepare(makeAgent({ repo: repoDir }), makeIdentity(configDir));

    const notifyPath = path.join(configDir, 'notify.sh');
    const notifyStat = await stat(notifyPath);
    expect(notifyStat.mode & 0o100).toBe(0o100);
    expect(await readFile(notifyPath, 'utf8')).toContain('http://127.0.0.1:3456/events/midgard');

    const override = await readFile(path.join(repoDir, 'AGENTS.override.md'), 'utf8');
    expect(override).toContain(GENERATED_MARKER);
    expect(override).toContain('conductor protocol placeholder');
  });

  it('inlines the protocol file and the repo AGENTS.md when both exist', async () => {
    const protocolPath = path.join(workDir, 'protocol.md');
    await writeFile(protocolPath, 'Report to the conductor via MCP.');
    await writeFile(path.join(repoDir, 'AGENTS.md'), '# House rules');

    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir, protocolPath });
    await runtime.prepare(makeAgent({ repo: repoDir }), makeIdentity(configDir));

    const override = await readFile(path.join(repoDir, 'AGENTS.override.md'), 'utf8');
    expect(override).toContain('# House rules');
    expect(override).toContain('Report to the conductor via MCP.');
  });

  it('is idempotent and refreshes its own generated override', async () => {
    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    const agent = makeAgent({ repo: repoDir });
    await runtime.prepare(agent, makeIdentity(configDir));
    await writeFile(path.join(repoDir, 'AGENTS.md'), '# Added later');
    await runtime.prepare(agent, makeIdentity(configDir));

    const override = await readFile(path.join(repoDir, 'AGENTS.override.md'), 'utf8');
    expect(override).toContain('# Added later');
  });

  it('never clobbers a human-authored AGENTS.override.md', async () => {
    const overridePath = path.join(repoDir, 'AGENTS.override.md');
    await writeFile(overridePath, '# Hand-written override');

    const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
    await runtime.prepare(makeAgent({ repo: repoDir }), makeIdentity(configDir));

    expect(await readFile(overridePath, 'utf8')).toBe('# Hand-written override');
  });

  it('creates a per-agent CODEX_HOME and symlinks shared auth in (H4)', async () => {
    const sharedHome = path.join(workDir, 'shared-codex');
    await mkdir(sharedHome, { recursive: true });
    await writeFile(path.join(sharedHome, 'auth.json'), '{"token":"shared"}');
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sharedHome;
    try {
      const runtime = new CodexRuntime({ config: SETTINGS, baseDir: workDir });
      await runtime.prepare(makeAgent({ repo: repoDir }), makeIdentity(configDir));

      const home = path.join(configDir, 'codex-home');
      expect((await stat(home)).isDirectory()).toBe(true);
      // Auth resolves through the symlink; sessions/ stays isolated to this home.
      expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe('{"token":"shared"}');
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
      await expect(runtime.prepare(makeAgent({ repo: repoDir }), makeIdentity(configDir))).resolves.toBeUndefined();
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
    expect(runtime.parseEvent({ type: 'agent-turn-start' })).toBeNull();
    expect(runtime.parseEvent({ type: 42 })).toBeNull();
    expect(runtime.parseEvent('agent-turn-complete')).toBeNull();
    expect(runtime.parseEvent(null)).toBeNull();
    expect(runtime.parseEvent(['agent-turn-complete'])).toBeNull();
  });
});

describe('parseInputClear', () => {
  const runtime = new CodexRuntime({ config: SETTINGS, baseDir: '/base' });

  it('reports clear for an empty composer row', () => {
    expect(runtime.parseInputClear('some output\n\n› \n  ⏎ send   Ctrl+J newline')).toBe(true);
  });

  it('reports clear for the composer placeholder', () => {
    expect(runtime.parseInputClear('› Ask Codex to do anything')).toBe(true);
  });

  it('reports not-clear when the operator has typed into the composer', () => {
    expect(runtime.parseInputClear('output\n› refactor the parser\n⏎ send')).toBe(false);
  });

  it('returns null when no composer row is visible', () => {
    expect(runtime.parseInputClear('plain shell output\n$ ')).toBeNull();
    expect(runtime.parseInputClear('')).toBeNull();
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
