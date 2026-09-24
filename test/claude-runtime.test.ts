import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { supervisorConfigSchema, type SessionConfig } from '../src/config/schema.js';
import { isolatedGitEnvironment } from '../src/core/git.js';
import { ClaudeCodeRuntime, seedFolderTrust } from '../src/runtimes/claude-code/index.js';
import { OpenCodexClaudeRuntime } from '../src/runtimes/opencodex/index.js';
import {
  parseClaudeActivityState,
  parseClaudeInputState,
  stripClaudeChrome,
} from '../src/runtimes/claude-code/chrome.js';
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
    config: defaults.runtimes.claudeCode,
    claudeJsonPath: join(configDir, '.claude.json'),
  });
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('buildLaunchCommand', () => {
  it('builds a fresh launch with cd, env exports, flags, and piped prompt', () => {
    const command = runtime.buildLaunchCommand(session, identity, {
      prompt: 'do the thing',
      bypassPermissions: true,
    });
    expect(command).toContain(`cd '/tmp/alpha repo'`);
    expect(command).toContain("export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='40'");
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

  it('strips UI chrome by default (bareUi)', () => {
    const command = runtime.buildLaunchCommand(session, identity, {});
    expect(command).toContain(`export IS_DEMO='1'`);
    expect(command).toContain(`export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION='false'`);
  });

  it('keeps the full UI when bareUi is disabled', () => {
    const custom = new ClaudeCodeRuntime({
      config: { ...defaults.runtimes.claudeCode, bareUi: false },
    });
    const command = custom.buildLaunchCommand(session, identity, {});
    expect(command).not.toContain('IS_DEMO');
    // Suggestions remain disabled even with full chrome because plain iTerm
    // capture cannot distinguish placeholder text from a real operator draft.
    expect(command).toContain(`export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION='false'`);
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

  it('passes through per-run, session, and fleet effort levels with per-run precedence', () => {
    const withDefault = new ClaudeCodeRuntime({
      config: { ...defaults.runtimes.claudeCode, defaultEffort: 'fleet-level' },
    });
    expect(withDefault.buildLaunchCommand(session, identity, {})).toContain(`--effort 'fleet-level'`);
    expect(withDefault.buildLaunchCommand({ ...session, effort: 'session-level' }, identity, {})).toContain(
      `--effort 'session-level'`,
    );
    expect(
      withDefault.buildLaunchCommand({ ...session, effort: 'session-level' }, identity, { effort: 'future-level' }),
    ).toContain(`--effort 'future-level'`);
  });

  it('keeps per-run effort authoritative over the higher-precedence native environment setting', () => {
    const withEnv = new ClaudeCodeRuntime({
      config: {
        ...defaults.runtimes.claudeCode,
        env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' },
      },
    });
    const command = withEnv.buildLaunchCommand(session, identity, { effort: 'future-level' });
    expect(command).toContain(`export CLAUDE_CODE_EFFORT_LEVEL='future-level'`);
    expect(command).not.toContain(`export CLAUDE_CODE_EFFORT_LEVEL='low'`);
    expect(command).toContain(`--effort 'future-level'`);
  });

  it('launches from the private prepared instruction snapshot, never the mutable source path', () => {
    const promptFile = join(configDir, 'sentinel.md');
    writeFileSync(promptFile, '# be the sentinel');
    const command = runtime.buildLaunchCommand({ ...session, systemPromptFile: promptFile }, identity, {});
    expect(command).toContain(`--append-system-prompt-file '${join(configDir, 'system-prompt.md')}'`);
    expect(command).not.toContain(promptFile);
  });

  it('does not silently append a configured source path before preparation', () => {
    const command = runtime.buildLaunchCommand({ ...session, systemPromptFile: '/nope/missing.md' }, identity, {});
    expect(command).not.toContain('/nope/missing.md');
    expect(command).toContain(join(configDir, 'system-prompt.md'));
  });

  it('uses -c for continuation and never pipes a prompt into it', () => {
    const command = runtime.buildLaunchCommand(session, identity, { continueSession: true, prompt: 'ignored' });
    expect(command).toContain('claude -c');
    expect(command).not.toContain('echo');
  });

  it('resumes an explicit session ID instead of the most recent conversation', () => {
    const command = runtime.buildLaunchCommand(session, identity, {
      continueSession: true,
      resumeSessionId: "provider'id",
    });
    expect(command).toContain("claude --resume 'provider'\\''id'");
    expect(command).not.toContain('claude -c');
  });

  it('keeps env overrides independent from the launch permission policy', () => {
    const custom = new ClaudeCodeRuntime({
      config: {
        ...defaults.runtimes.claudeCode,
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', EXTRA: 'yes' },
      },
    });
    const command = custom.buildLaunchCommand(session, identity, {});
    expect(command).not.toContain('--dangerously-skip-permissions');
    expect(command).toContain(`export CLAUDE_CODE_DISABLE_AUTO_MEMORY='0'`);
    expect(command).toContain(`export EXTRA='yes'`);
  });

  it('applies permission bypass only when requested by the launch', () => {
    expect(runtime.buildLaunchCommand(session, identity, { bypassPermissions: true })).toContain(
      '--dangerously-skip-permissions',
    );
    expect(runtime.buildLaunchCommand(session, identity, { bypassPermissions: false })).not.toContain(
      '--dangerously-skip-permissions',
    );
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
      spinnerTipsEnabled?: boolean;
    };
    for (const event of ['UserPromptSubmit', 'Stop', 'Notification', 'PreCompact', 'SessionEnd', 'SessionStart']) {
      const command = settings.hooks[event]?.[0]?.hooks[0]?.command;
      expect(command).toContain(identity.eventsUrl);
      expect(command).toContain('|| true');
    }
    // bareUi (default) also turns spinner tips off via the same settings file.
    expect(settings.spinnerTipsEnabled).toBe(false);
  });

  it('turns off Claude Code native agent messaging by default', async () => {
    await runtime.prepare(session, identity);
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      permissions?: { deny?: string[] };
      crossSessionInbound?: string;
    };
    expect(settings.permissions?.deny).toEqual(['SendMessage', 'ListAgents']);
    expect(settings.crossSessionInbound).toBe('refuse');
  });

  it('leaves native agent messaging alone when a fleet re-enables it', async () => {
    const custom = new ClaudeCodeRuntime({
      config: {
        ...defaults.runtimes.claudeCode,
        nativeAgentMessaging: true,
      },
      claudeJsonPath: join(configDir, '.claude.json'),
    });
    await custom.prepare(session, identity);
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings.permissions).toBeUndefined();
    expect(settings.crossSessionInbound).toBeUndefined();
  });

  it('leaves spinner tips alone when bareUi is disabled', async () => {
    const custom = new ClaudeCodeRuntime({
      config: {
        ...defaults.runtimes.claudeCode,
        bareUi: false,
      },
      claudeJsonPath: join(configDir, '.claude.json'),
    });
    await custom.prepare(session, identity);
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      spinnerTipsEnabled?: boolean;
    };
    expect(settings.spinnerTipsEnabled).toBeUndefined();
  });

  it('launches snapshotted session instructions before the final protocol and fails visibly for a missing source', async () => {
    const protocolPath = join(configDir, 'source-protocol.md');
    const sessionPath = join(configDir, 'source-session.md');
    writeFileSync(protocolPath, 'PROTOCOL SOURCE');
    writeFileSync(sessionPath, 'SESSION SOURCE');
    const custom = new ClaudeCodeRuntime({
      config: defaults.runtimes.claudeCode,
      protocolPath,
      claudeJsonPath: join(configDir, '.claude.json'),
    });
    const configured = { ...session, systemPromptFile: sessionPath };
    await custom.prepare(configured, identity);

    expect(readFileSync(join(configDir, 'conductor-protocol.md'), 'utf8')).toBe('PROTOCOL SOURCE\n');
    expect(readFileSync(join(configDir, 'session-instructions.md'), 'utf8')).toBe('SESSION SOURCE\n');
    expect(readFileSync(join(configDir, 'system-prompt.md'), 'utf8')).toBe('SESSION SOURCE\n\nPROTOCOL SOURCE\n');

    await expect(
      custom.prepare({ ...session, systemPromptFile: join(configDir, 'missing.md') }, identity),
    ).rejects.toThrow(/Could not read session instructions/u);
  });

  describe('single combined system-prompt file', () => {
    const appendFlags = (command: string): string[] =>
      [...command.matchAll(/--append-system-prompt-file '([^']+)'/gu)].map((match) => match[1]!);

    function protocolRuntime(protocolText: string): ClaudeCodeRuntime {
      const protocolPath = join(configDir, 'source-protocol.md');
      writeFileSync(protocolPath, protocolText);
      return new ClaudeCodeRuntime({
        config: defaults.runtimes.claudeCode,
        protocolPath,
        claudeJsonPath: join(configDir, '.claude.json'),
      });
    }

    it('passes exactly one append flag on start, continue, and native resume', async () => {
      // Claude Code keeps only the last --append-system-prompt-file; a second
      // flag would silently drop the session layer.
      const sessionPath = join(configDir, 'source-session.md');
      writeFileSync(sessionPath, 'SESSION LAYER');
      const custom = protocolRuntime('PROTOCOL LAYER');
      const configured = { ...session, systemPromptFile: sessionPath };
      await custom.prepare(configured, identity);
      const combined = join(configDir, 'system-prompt.md');
      for (const options of [{}, { continueSession: true }, { continueSession: true, resumeSessionId: 'abc' }]) {
        expect(appendFlags(custom.buildLaunchCommand(configured, identity, options))).toEqual([combined]);
      }
    });

    it('keeps the protocol last and complete beside a session layer at its size limit', async () => {
      const sessionText = `${'s'.repeat(5_119)}\n`;
      const protocolText = `PROTOCOL START\n${'p'.repeat(20_000)}\nPROTOCOL END\n`;
      const sessionPath = join(configDir, 'source-session.md');
      writeFileSync(sessionPath, sessionText);
      const custom = protocolRuntime(protocolText);
      await custom.prepare({ ...session, systemPromptFile: sessionPath }, identity);
      expect(readFileSync(join(configDir, 'system-prompt.md'), 'utf8')).toBe(`${sessionText}\n${protocolText}`);

      writeFileSync(sessionPath, `${'s'.repeat(5_121)}`);
      await expect(custom.prepare({ ...session, systemPromptFile: sessionPath }, identity)).rejects.toThrow(
        /limit is 5120/u,
      );
    });

    it('rewrites the combined file to the protocol alone when the session layer is removed', async () => {
      const sessionPath = join(configDir, 'source-session.md');
      writeFileSync(sessionPath, 'SESSION LAYER');
      const custom = protocolRuntime('PROTOCOL LAYER');
      await custom.prepare({ ...session, systemPromptFile: sessionPath }, identity);
      await custom.prepare(session, identity);
      expect(readFileSync(join(configDir, 'system-prompt.md'), 'utf8')).toBe('PROTOCOL LAYER\n');
      expect(appendFlags(custom.buildLaunchCommand(session, identity, {}))).toHaveLength(1);
    });

    it('passes no append flag and leaves no stale file when there are no layers', async () => {
      writeFileSync(join(configDir, 'system-prompt.md'), 'STALE');
      await runtime.prepare(session, identity);
      expect(readdirSync(configDir)).not.toContain('system-prompt.md');
      expect(appendFlags(runtime.buildLaunchCommand(session, identity, {}))).toEqual([]);
    });

    it('applies to the OpenCodex Claude profile, which reuses this launch path', async () => {
      const sessionPath = join(configDir, 'source-session.md');
      writeFileSync(sessionPath, 'SESSION LAYER');
      const protocolPath = join(configDir, 'source-protocol.md');
      writeFileSync(protocolPath, 'PROTOCOL LAYER');
      const proxied = new OpenCodexClaudeRuntime(
        { config: defaults.runtimes.claudeCode, protocolPath, claudeJsonPath: join(configDir, '.claude.json') },
        'http://127.0.0.1:10100',
      );
      const configured = { ...session, model: 'provider/model', systemPromptFile: sessionPath };
      await proxied.prepare(configured, identity);
      expect(appendFlags(proxied.buildLaunchCommand(configured, identity, {}))).toEqual([
        join(configDir, 'system-prompt.md'),
      ]);
    });
  });

  it('reads continuity state fresh at startup, resume, and compact without restoring it on clear', async () => {
    const statePath = join(configDir, 'state.md');
    writeFileSync(statePath, 'STATE VERSION ONE');
    await runtime.prepare({ ...session, continuityStateFile: statePath }, identity);

    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>;
    };
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart?.[0]?.matcher).toBe('^(startup|resume|compact)$');
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.timeout).toBe(5);
    expect(settings.hooks.SessionStart?.[1]?.hooks[0]?.command).toContain(identity.eventsUrl);

    const readerName = readdirSync(configDir).find((entry) => entry.startsWith('continuity-state-reader-'));
    expect(readerName).toBeDefined();
    const run = (source: 'startup' | 'resume' | 'compact'): string => {
      const output = JSON.parse(
        execFileSync(process.execPath, [join(configDir, readerName!)], {
          input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
          encoding: 'utf8',
          env: { ...process.env, PATH: '' },
        }),
      ) as { hookSpecificOutput: { additionalContext: string } };
      return output.hookSpecificOutput.additionalContext;
    };
    expect(run('startup')).toContain('STATE VERSION ONE');
    writeFileSync(statePath, 'STATE VERSION TWO');
    expect(run('resume')).toContain('STATE VERSION TWO');
    expect(run('compact')).toContain('STATE VERSION TWO');
    expect(JSON.stringify(settings.hooks.SessionStart)).not.toContain('clear');

    await runtime.prepare(session, identity);
    expect(readdirSync(configDir).some((entry) => entry.startsWith('continuity-state-reader-'))).toBe(false);
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
    expect(
      runtime.parseEvent({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Approve',
      }),
    ).toMatchObject({ type: 'notification', notificationType: 'permission_prompt' });
    expect(
      runtime.parseEvent({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Idle' }),
    ).toMatchObject({ type: 'notification', notificationType: 'idle_prompt' });
    expect(
      runtime.parseEvent({
        hook_event_name: 'Notification',
        notification_type: 'elicitation_dialog',
        message: 'Choose',
      }),
    ).toMatchObject({ type: 'notification', notificationType: 'elicitation_dialog' });
    expect(runtime.parseEvent({ hook_event_name: 'PreCompact' })?.type).toBe('compaction');
    expect(runtime.parseEvent({ hook_event_name: 'SessionStart', source: 'compact' })?.type).toBe(
      'compaction-complete',
    );
    expect(runtime.parseEvent({ hook_event_name: 'SessionStart', source: 'startup' })?.type).toBe('session-start');
    expect(runtime.parseEvent({ hook_event_name: 'UserPromptSubmit' })?.type).toBe('turn-start');
    expect(runtime.parseEvent({ hook_event_name: 'SessionEnd' })?.type).toBe('session-end');
    expect(
      runtime.parseEvent({
        hook_event_name: 'ContinuityStateRestoration',
        source: 'compact',
        outcome: 'emitted',
        byte_count: 17,
      }),
    ).toEqual({
      type: 'continuity-restoration',
      continuitySource: 'compact',
      continuityOutcome: 'emitted',
      byteCount: 17,
    });
    expect(runtime.parseEvent({ hook_event_name: 'Whatever' })).toBeNull();
    expect(runtime.parseEvent('garbage')).toBeNull();
  });
});

describe('chrome parsing', () => {
  it('detects a clear input line', () => {
    expect(parseClaudeInputState('some output\n│ ❯ │')).toBe('clear');
    expect(parseClaudeInputState('some output\n❯ half-typed messa')).toBe('draft');
    expect(parseClaudeInputState('no prompt glyph anywhere')).toBeNull();
  });

  it('uses the LAST prompt line in the capture', () => {
    expect(parseClaudeInputState('❯ old submitted line\noutput\n❯ ')).toBe('clear');
  });

  it('keeps an active turn working even when Claude also renders a composer', () => {
    const capture = ['assistant output', '❯ queued follow-up', '✻ Thinking deeply… (esc to interrupt)'].join('\n');
    expect(parseClaudeInputState(capture)).toBe('draft');
    expect(parseClaudeActivityState(capture)).toBe('working');
  });

  it('recognizes the current Claude pulse row without an interrupt hint', () => {
    const capture = [
      'assistant output',
      '❯',
      '· Boogieling… (50s · ↓ 2.1k tokens · thinking with xhigh effort)',
      'Fable 5 | 34% | project',
    ].join('\n');
    expect(parseClaudeActivityState(capture)).toBe('working');
    expect(parseClaudeActivityState('✽ Reading… (2s)')).toBe('working');
  });

  it('does not mistake a completed Claude duration summary for an active pulse', () => {
    expect(parseClaudeActivityState('assistant output\n* Baked for 20s\n\n❯')).toBe('idle');
  });

  it('keeps a turn working when queued input pushes the pulse row out of the capture', () => {
    const capture = [
      'a long final response whose activity row is no longer visible',
      'more response output',
      '❯',
      'Press up to edit queued messages',
      'Fable 5 | 38% | project',
    ].join('\n');
    expect(parseClaudeActivityState(capture)).toBe('working');
  });

  it('ignores the frozen pulse rows that previous turns leave in scrollback', () => {
    // Real capture shape from a live iTerm pane: Claude redraws its pulse row in
    // place, so every completed turn leaves its final frame in the buffer. Only
    // the row beside the live composer describes the current turn.
    const separator = '─'.repeat(60);
    const capture = [
      '⏺ Written. Now I will hand off the path. ',
      '✻ Puttering… (2m 42s · ↓ 5.0k tokens · thought for 1s) ',
      separator,
      '· Puttering… (2m 42s · ↓ 5.2k tokens · thought for 1s) ',
      separator,
      '❯   ',
      separator,
      '  Opus 4.8 | 11% | $6.09 | 📁 project | 🌳 no worktree | 🌿 main ',
      '⏺ A later reply that arrived after that older frame. ',
      '✻ Churned for 22s ',
      '',
      separator,
      '❯   ',
      separator,
      '  Opus 4.8 | 13% | $8.14 | 📁 project | 🌳 no worktree | 🌿 main ',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents ',
    ].join('\n');
    expect(parseClaudeActivityState(capture)).toBe('idle');
  });

  it('reads the live pulse row when the newest frame is still working', () => {
    const separator = '─'.repeat(60);
    const capture = [
      '✻ Puttering… (2m 42s · ↓ 5.0k tokens · thought for 1s) ',
      separator,
      '❯   ',
      separator,
      '⏺ Before toggling — I need to read the result rather than blindly flip. ',
      '✻ Boondoggling… (56s · ↓ 3.3k tokens · thinking with high effort) ',
      '',
      separator,
      '❯   ',
      separator,
      '  Opus 4.8 | 14% | $8.55 | 📁 project | 🌳 no worktree | 🌿 main ',
    ].join('\n');
    expect(parseClaudeActivityState(capture)).toBe('working');
  });

  it('never calls a working session idle when a long draft clips the status row', () => {
    // A peer's long message expands the composer past the capture window, so the
    // pulse row is no longer visible. Reporting idle here would stall the very
    // session that just received the message.
    const capture = [
      '  ...earlier output whose status row is out of view... ',
      '',
      '─'.repeat(60),
      '❯ [Message from agent-b] here is the long brief: ',
      ...Array.from({ length: 30 }, (_, index) => `  paragraph line ${String(index + 1)} of the brief`),
      '─'.repeat(60),
      '  Opus 4.8 | 13% | $8.14 | 📁 project | 🌳 no worktree | 🌿 main ',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents ',
    ].join('\n');
    expect(parseClaudeActivityState(capture)).toBe('unknown');
    expect(parseClaudeInputState(capture)).toBe('draft');
  });

  it('uses only a current composer as idle evidence', () => {
    expect(parseClaudeActivityState('assistant output\n❯ \nshift+tab to cycle')).toBe('idle');
    expect(parseClaudeActivityState('❯ old submitted line\nnew model output')).toBe('unknown');
    expect(
      parseClaudeActivityState('assistant output\n❯ \nOpus | 42% | $1.24 | 📁 project | 🌳 no worktree | 🌿 main'),
    ).toBe('idle');
  });

  it('treats every non-empty composer as a draft, including suggestion-shaped text', () => {
    // Suggestions are disabled at launch. If suggestion-shaped text is still
    // visible, safety wins: iTerm cannot prove whether it was typed.
    expect(parseClaudeInputState('output\n│ ❯ Try "fix lint errors" │')).toBe('draft');
    expect(parseClaudeInputState('output\n❯ Try “refactor the parser” to get started')).toBe('draft');
    expect(parseClaudeInputState('output\n❯ Try harder next time')).toBe('draft');
  });

  it('ignores signatures when classifying occupied input', () => {
    expect(parseClaudeInputState('output\n❯ [Message from operator] do the thing')).toBe('draft');
    expect(parseClaudeInputState('output\n❯ [Broadcast from tester] heads up')).toBe('draft');
    expect(parseClaudeInputState('output\n❯ [Stall] session=alpha kind=idle …')).toBe('draft');
    expect(parseClaudeInputState('output\n❯ tell tester to [Message me back]')).toBe('draft');
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
    await seedFolderTrust(claudeJson(), ['/tmp/spawned']);
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
    await seedFolderTrust(claudeJson(), ['/tmp/spawned']);
    const root = read();
    expect(root.oauthAccount).toEqual({ email: 'x@y.z' });
    const projects = root.projects as Record<string, unknown>;
    expect(projects['/other']).toEqual({ hasTrustDialogAccepted: true, history: [1] });
    expect(projects['/tmp/spawned']).toEqual({ hasTrustDialogAccepted: true });
  });

  it('preserves other per-project fields when trusting an existing project', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ projects: { '/tmp/spawned': { history: ['a'] } } }));
    await seedFolderTrust(claudeJson(), ['/tmp/spawned']);
    expect((read().projects as Record<string, unknown>)['/tmp/spawned']).toEqual({
      history: ['a'],
      hasTrustDialogAccepted: true,
    });
  });

  it('NEVER overwrites an existing file it cannot parse — that is the real Claude config', async () => {
    writeFileSync(claudeJson(), '{corrupt json!!');
    await seedFolderTrust(claudeJson(), ['/tmp/spawned']);
    expect(readFileSync(claudeJson(), 'utf8')).toBe('{corrupt json!!');
  });

  it('trusts every path a runtime might resolve the project to (literal cwd, realpath, git root)', async () => {
    await seedFolderTrust(claudeJson(), ['/tmp/spawned', '/private/tmp/spawned', '/private/tmp/main-repo']);
    const projects = read().projects as Record<string, { hasTrustDialogAccepted: boolean }>;
    expect(projects['/tmp/spawned']?.hasTrustDialogAccepted).toBe(true);
    expect(projects['/private/tmp/spawned']?.hasTrustDialogAccepted).toBe(true);
    expect(projects['/private/tmp/main-repo']?.hasTrustDialogAccepted).toBe(true);
  });

  it('creates the CLAUDE_CONFIG_DIR-style parent directory when the target file does not live there yet', async () => {
    const nested = join(configDir, 'nested', 'claude-config', '.claude.json');
    await seedFolderTrust(nested, ['/tmp/spawned']);
    expect(JSON.parse(readFileSync(nested, 'utf8')) as unknown).toEqual({
      projects: { '/tmp/spawned': { hasTrustDialogAccepted: true } },
    });
  });

  it('writes atomically: a failed write never leaves a corrupt or partial file behind', async () => {
    await seedFolderTrust(claudeJson(), ['/tmp/spawned']);
    const before = readFileSync(claudeJson(), 'utf8');
    // A second call with an already-trusted path is a no-op write; content is unchanged either way.
    await seedFolderTrust(claudeJson(), ['/tmp/spawned']);
    expect(readFileSync(claudeJson(), 'utf8')).toBe(before);
    expect(readdirSync(configDir).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });
});

describe('resolveTrustPaths (via ClaudeCodeRuntime.prepare)', () => {
  // Mirrors the Codex runtime's trust-preseeding coverage: Claude Code also
  // compares resolved paths and applies trust at the Git repository root, so
  // seedFolderTrust must receive every path Claude might resolve the project
  // to. These exercise it through the real runtime.prepare() call, the same
  // path a launch takes.
  let workDir: string;
  const gitEnv = isolatedGitEnvironment();
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      stdio: 'ignore',
      env: gitEnv,
    });
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'claude-trust-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('trusts the literal cwd, worktree top level, and resolved main-repository root for a linked worktree', async () => {
    const main = join(workDir, 'main-repo');
    mkdirSync(main, { recursive: true });
    git(main, 'init', '-b', 'main');
    writeFileSync(join(main, 'file.txt'), 'hi');
    git(main, 'add', 'file.txt');
    git(main, 'commit', '-m', 'init');
    const worktree = join(workDir, 'wt');
    execFileSync('git', ['-C', main, 'worktree', 'add', '-b', 'wt-branch', worktree], { env: gitEnv });

    const claudeJsonPath = join(workDir, '.claude.json');
    const wtRuntime = new ClaudeCodeRuntime({ config: defaults.runtimes.claudeCode, claudeJsonPath });
    await wtRuntime.prepare({ ...session, repo: worktree }, identity);

    const trust = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as { projects: Record<string, unknown> };
    const realWorktree = execFileSync('sh', ['-c', `cd '${worktree}' && pwd -P`], { encoding: 'utf8' }).trim();
    const realMain = execFileSync('sh', ['-c', `cd '${main}' && pwd -P`], { encoding: 'utf8' }).trim();
    expect(Object.keys(trust.projects)).toEqual(expect.arrayContaining([worktree, realWorktree, realMain]));
  });
});
