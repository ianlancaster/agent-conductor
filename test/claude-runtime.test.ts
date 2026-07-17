import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { supervisorConfigSchema, type SessionConfig } from '../src/config/schema.js';
import { ClaudeCodeRuntime, seedFolderTrust } from '../src/runtimes/claude-code/index.js';
import { parseClaudeInputClear, stripClaudeChrome } from '../src/runtimes/claude-code/chrome.js';
import type { IdentityEndpoints } from '../src/runtimes/types.js';

const defaults = supervisorConfigSchema.parse({});

const session: SessionConfig = {
  codename: 'alpha',
  repo: '/tmp/alpha repo',
  runtime: 'claude-code',
  additionalDirs: ['/tmp/shared'],
  schedules: [],
};

let configDir: string;
let identity: IdentityEndpoints;
let runtime: ClaudeCodeRuntime;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'conductor-claude-'));
  identity = {
    mcpUrl: 'http://127.0.0.1:3456/mcp/alpha',
    eventsUrl: 'http://127.0.0.1:3456/events/alpha',
    configDir,
  };
  runtime = new ClaudeCodeRuntime({
    config: { ...defaults.runtimes.claudeCode, claudeJsonPath: join(configDir, '.claude.json') },
  });
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('buildLaunchCommand', () => {
  it('builds a fresh launch with cd, env exports, flags, and piped prompt', () => {
    const command = runtime.buildLaunchCommand(session, identity, { prompt: 'do the thing' });
    expect(command).toContain(`cd '/tmp/alpha repo'`);
    expect(command).toContain('export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=');
    expect(command).toContain(`echo 'do the thing' | claude`);
    expect(command).toContain('--dangerously-skip-permissions');
    expect(command).toContain(`--add-dir '/tmp/shared'`);
    expect(command).toContain(`--mcp-config '${join(configDir, 'mcp.json')}'`);
    expect(command).toContain(`--settings '${join(configDir, 'settings.json')}'`);
    // Configurable, default ON.
    expect(command).toContain(`export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'`);
  });

  it('omits CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC when disabled in config', () => {
    const custom = new ClaudeCodeRuntime({
      config: { ...defaults.runtimes.claudeCode, disableNonessentialTraffic: false },
    });
    expect(custom.buildLaunchCommand(session, identity, {})).not.toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
  });

  it('passes the session model — the cc-conductor bug fix', () => {
    const command = runtime.buildLaunchCommand({ ...session, model: 'claude-opus-4-6' }, identity, {});
    expect(command).toContain(`--model 'claude-opus-4-6'`);
  });

  it('falls back to the configured default model', () => {
    const withDefault = new ClaudeCodeRuntime({
      config: { ...defaults.runtimes.claudeCode, defaultModel: 'claude-sonnet-5' },
    });
    expect(withDefault.buildLaunchCommand(session, identity, {})).toContain(`--model 'claude-sonnet-5'`);
  });

  it('appends a per-session systemPromptFile after the conductor protocol when it exists', () => {
    const promptFile = join(configDir, 'sentinel.md');
    writeFileSync(promptFile, '# be the sentinel');
    const command = runtime.buildLaunchCommand({ ...session, systemPromptFile: promptFile }, identity, {});
    expect(command).toContain(`--append-system-prompt-file '${promptFile}'`);
  });

  it('skips a per-session systemPromptFile that does not exist', () => {
    const command = runtime.buildLaunchCommand({ ...session, systemPromptFile: '/nope/missing.md' }, identity, {});
    expect(command).not.toContain('/nope/missing.md');
  });

  it('uses -c for continuation and never pipes a prompt into it', () => {
    const command = runtime.buildLaunchCommand(session, identity, { continueSession: true, prompt: 'ignored' });
    expect(command).toContain('claude -c');
    expect(command).not.toContain('echo');
  });

  it('respects env overrides and skipPermissions=false', () => {
    const custom = new ClaudeCodeRuntime({
      config: {
        ...defaults.runtimes.claudeCode,
        skipPermissions: false,
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', EXTRA: 'yes' },
      },
    });
    const command = custom.buildLaunchCommand(session, identity, {});
    expect(command).not.toContain('--dangerously-skip-permissions');
    expect(command).toContain(`export CLAUDE_CODE_DISABLE_AUTO_MEMORY='0'`);
    expect(command).toContain(`export EXTRA='yes'`);
  });

  it('shell-quotes hostile prompts', () => {
    const command = runtime.buildLaunchCommand(session, identity, { prompt: `it's; rm -rf /` });
    expect(command).toContain(`echo 'it'\\''s; rm -rf /' | claude`);
  });
});

describe('prepare', () => {
  it('writes MCP identity config and hook settings', async () => {
    await runtime.prepare(session, identity);
    const mcp = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf8')) as {
      mcpServers: { conductor: { url: string } };
    };
    expect(mcp.mcpServers.conductor.url).toBe(identity.mcpUrl);

    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    for (const event of ['Stop', 'Notification', 'PreCompact', 'SessionEnd', 'SessionStart']) {
      const command = settings.hooks[event]?.[0]?.hooks[0]?.command;
      expect(command).toContain(identity.eventsUrl);
      expect(command).toContain('|| true');
    }
  });
});

describe('parseEvent', () => {
  it('maps hook payloads to runtime events', () => {
    expect(runtime.parseEvent({ hook_event_name: 'Stop', transcript_path: '/t.jsonl' })).toEqual({
      type: 'stop',
      reason: undefined,
      transcriptPath: '/t.jsonl',
    });
    expect(runtime.parseEvent({ hook_event_name: 'Notification', message: 'needs permission' })?.type).toBe(
      'notification',
    );
    expect(runtime.parseEvent({ hook_event_name: 'PreCompact' })?.type).toBe('compaction');
    expect(runtime.parseEvent({ hook_event_name: 'SessionEnd' })?.type).toBe('session-end');
    expect(runtime.parseEvent({ hook_event_name: 'Whatever' })).toBeNull();
    expect(runtime.parseEvent('garbage')).toBeNull();
  });
});

describe('chrome parsing', () => {
  it('detects a clear input line', () => {
    expect(parseClaudeInputClear('some output\n│ ❯ │')).toBe(true);
    expect(parseClaudeInputClear('some output\n❯ half-typed messa')).toBe(false);
    expect(parseClaudeInputClear('no prompt glyph anywhere')).toBeNull();
  });

  it('uses the LAST prompt line in the capture', () => {
    expect(parseClaudeInputClear('❯ old submitted line\noutput\n❯ ')).toBe(true);
  });

  it('treats the ghost placeholder as an EMPTY input line', () => {
    // Claude renders suggestion ghost text inside an empty input box. Plain
    // captures can't see the dim styling, and reading it as typed input made
    // idle sessions look busy forever (tester Issue #3).
    expect(parseClaudeInputClear('output\n│ ❯ Try "fix lint errors" │')).toBe(true);
    expect(parseClaudeInputClear('output\n❯ Try “refactor the parser” to get started')).toBe(true);
    // Real typed text that merely starts with Try but has no quote is busy.
    expect(parseClaudeInputClear('output\n❯ Try harder next time')).toBe(false);
  });

  it('strips trailing chrome but keeps content', () => {
    const capture = ['real output line', 'more output', '  ❯ ', 'shift+tab to cycle'].join('\n');
    expect(stripClaudeChrome(capture)).toBe('real output line\nmore output');
  });
});

describe('seedFolderTrust', () => {
  const claudeJson = (): string => join(configDir, '.claude.json');
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(claudeJson(), 'utf8')) as Record<string, unknown>;

  it('creates the file and trusts the repo when no config exists', async () => {
    await seedFolderTrust(claudeJson(), '/tmp/spawned');
    expect(read()).toEqual({ projects: { '/tmp/spawned': { hasTrustDialogAccepted: true } } });
  });

  it('adds trust without disturbing existing config', async () => {
    writeFileSync(
      claudeJson(),
      JSON.stringify({
        oauthAccount: { email: 'x@y.z' },
        projects: { '/other': { hasTrustDialogAccepted: true, history: [1] } },
      }),
    );
    await seedFolderTrust(claudeJson(), '/tmp/spawned');
    const root = read();
    expect(root.oauthAccount).toEqual({ email: 'x@y.z' });
    const projects = root.projects as Record<string, unknown>;
    expect(projects['/other']).toEqual({ hasTrustDialogAccepted: true, history: [1] });
    expect(projects['/tmp/spawned']).toEqual({ hasTrustDialogAccepted: true });
  });

  it('preserves other per-project fields when trusting an existing project', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ projects: { '/tmp/spawned': { history: ['a'] } } }));
    await seedFolderTrust(claudeJson(), '/tmp/spawned');
    expect((read().projects as Record<string, unknown>)['/tmp/spawned']).toEqual({
      history: ['a'],
      hasTrustDialogAccepted: true,
    });
  });

  it('NEVER overwrites an existing file it cannot parse — that is the real Claude config', async () => {
    writeFileSync(claudeJson(), '{corrupt json!!');
    await seedFolderTrust(claudeJson(), '/tmp/spawned');
    expect(readFileSync(claudeJson(), 'utf8')).toBe('{corrupt json!!');
  });
});
