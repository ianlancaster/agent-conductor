import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionConfig, SupervisorConfig } from '../../config/schema.js';
import type { RuntimeEvent } from '../../core/types.js';
import { shellQuote } from '../../core/shell.js';
import type { SessionRuntime, IdentityEndpoints, InputState, LaunchOptions, RuntimeCapabilities } from '../types.js';
import { parseClaudeInputState, stripClaudeChrome } from './chrome.js';
import { readLastAssistantMessage } from './transcript.js';

type ClaudeCodeConfig = SupervisorConfig['runtimes']['claudeCode'];

/** Hook events wired into every session. All POST their stdin JSON to the events endpoint. */
const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'Notification', 'PreCompact', 'SessionEnd', 'SessionStart'] as const;

const EVENT_MAP: Record<string, RuntimeEvent['type']> = {
  UserPromptSubmit: 'turn-start',
  Stop: 'stop',
  Notification: 'notification',
  PreCompact: 'compaction',
  SessionEnd: 'session-end',
  SessionStart: 'session-start',
};

export interface ClaudeCodeRuntimeOptions {
  config: ClaudeCodeConfig;
  /** Path to the conductor protocol prompt appended to every session's system prompt. */
  protocolPath?: string;
  /** Override Claude's state path when embedding the runtime (primarily for isolated tests). */
  claudeJsonPath?: string;
}

/**
 * Pre-accept Claude Code's folder-trust dialog for a session's repo.
 * `--dangerously-skip-permissions` does NOT cover the separate trust gate, so
 * a freshly-spawned directory otherwise boots into "do you trust this
 * folder?" and sits not-ready until someone answers. Best-effort: a corrupt
 * or unwritable ~/.claude.json must never block a launch.
 */
export async function seedFolderTrust(claudeJsonPath: string, repo: string): Promise<void> {
  try {
    let root: Record<string, unknown> = {};
    if (existsSync(claudeJsonPath)) {
      // An existing file that fails to parse must NOT be overwritten — it is
      // the user's real Claude config (auth, history). Skip seeding instead.
      const parsed: unknown = JSON.parse(await readFile(claudeJsonPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return;
      root = parsed as Record<string, unknown>;
    }
    const projects =
      typeof root.projects === 'object' && root.projects !== null ? (root.projects as Record<string, unknown>) : {};
    const entry =
      typeof projects[repo] === 'object' && projects[repo] !== null ? (projects[repo] as Record<string, unknown>) : {};
    if (entry.hasTrustDialogAccepted === true) return;
    entry.hasTrustDialogAccepted = true;
    projects[repo] = entry;
    root.projects = projects;
    await writeFile(claudeJsonPath, JSON.stringify(root, null, 2));
  } catch (err) {
    // Never let trust seeding break a launch.
    void err;
  }
}

export class ClaudeCodeRuntime implements SessionRuntime {
  readonly name = 'claude-code';
  readonly capabilities: RuntimeCapabilities = {
    lifecycleEvents: true,
    authoritativeTurnCompletion: true,
    contextProbe: true,
    styledCapture: false,
  };

  private readonly config: ClaudeCodeConfig;
  private readonly protocolPath: string | undefined;
  private readonly claudeJsonPath: string;

  constructor(opts: ClaudeCodeRuntimeOptions) {
    this.config = opts.config;
    this.protocolPath = opts.protocolPath;
    this.claudeJsonPath = opts.claudeJsonPath ?? join(homedir(), '.claude.json');
  }

  async prepare(session: SessionConfig, identity: IdentityEndpoints): Promise<void> {
    await mkdir(identity.configDir, { recursive: true });
    await writeFile(this.mcpConfigPath(identity), `${JSON.stringify(this.buildMcpConfig(identity), null, 2)}\n`);
    await writeFile(this.hooksSettingsPath(identity), `${JSON.stringify(this.buildHookSettings(identity), null, 2)}\n`);
    await seedFolderTrust(this.claudeJsonPath, session.repo);
  }

  buildLaunchCommand(session: SessionConfig, identity: IdentityEndpoints, opts: LaunchOptions): string {
    const parts: string[] = [`cd ${shellQuote(session.repo)}`];
    const effort =
      opts.effort ?? session.effort ?? this.config.defaultEffort ?? this.config.env.CLAUDE_CODE_EFFORT_LEVEL;

    const env = this.envVars();
    // Claude Code's native environment setting outranks --effort. Replace it
    // with the resolved value so a generic runtime env cannot defeat a per-run pin.
    if (effort !== undefined) env.CLAUDE_CODE_EFFORT_LEVEL = effort;
    for (const [key, value] of Object.entries(env)) {
      parts.push(`export ${key}=${shellQuote(value)}`);
    }

    const flags: string[] = [];
    if (opts.continueSession) flags.push('-c');
    if (opts.bypassPermissions === true) flags.push('--dangerously-skip-permissions');
    const model = session.model ?? this.config.defaultModel;
    if (model !== undefined) flags.push('--model', shellQuote(model));
    if (effort !== undefined) flags.push('--effort', shellQuote(effort));
    for (const dir of session.additionalDirs) {
      flags.push('--add-dir', shellQuote(dir));
    }
    flags.push('--mcp-config', shellQuote(this.mcpConfigPath(identity)));
    flags.push('--settings', shellQuote(this.hooksSettingsPath(identity)));
    // Conductor protocol first (all sessions), then any per-session instructions
    // (e.g. the sentinel prompt). Claude Code allows repeated appends.
    const promptFile = this.systemPromptPath();
    if (promptFile !== undefined) {
      flags.push('--append-system-prompt-file', shellQuote(promptFile));
    }
    if (session.systemPromptFile !== undefined && existsSync(session.systemPromptFile)) {
      flags.push('--append-system-prompt-file', shellQuote(session.systemPromptFile));
    }

    const claude = `${this.config.binary} ${flags.join(' ')}`;
    const launch =
      opts.prompt !== undefined && !opts.continueSession ? `echo ${shellQuote(opts.prompt)} | ${claude}` : claude;
    parts.push(launch);
    return parts.join(' && ');
  }

  parseInputState(capture: string): InputState {
    return parseClaudeInputState(capture);
  }

  stripChrome(capture: string): string {
    return stripClaudeChrome(capture);
  }

  parseEvent(body: unknown): Omit<RuntimeEvent, 'session' | 'receivedAt'> | null {
    if (typeof body !== 'object' || body === null) return null;
    const record = body as Record<string, unknown>;
    const hookEvent = record.hook_event_name;
    if (typeof hookEvent !== 'string') return null;
    if (hookEvent === 'SessionStart' && record.source === 'compact') {
      return { type: 'compaction-complete' };
    }
    const type = EVENT_MAP[hookEvent];
    if (type === undefined) return null;
    return {
      type,
      reason: typeof record.message === 'string' ? record.message : undefined,
      transcriptPath: typeof record.transcript_path === 'string' ? record.transcript_path : undefined,
    };
  }

  readLastAssistantMessage(transcriptPath: string): Promise<string | null> {
    return readLastAssistantMessage(transcriptPath);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private envVars(): Record<string, string> {
    return {
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(this.config.autocompactPct),
      ...(this.config.disableNonessentialTraffic ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {}),
      // Plain iTerm capture cannot distinguish prompt suggestions from real
      // typed input. Disable them in every Conductor session so only a truly
      // empty composer can authorize protected delivery. IS_DEMO remains the
      // broader bare-UI switch; spinner tips are handled in settings.
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
      ...(this.config.bareUi ? { IS_DEMO: '1' } : {}),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1',
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
      // Claude's default MCP tool timeout is too short for slower conductor
      // tools (start_session waits for a pane launch).
      MCP_TOOL_TIMEOUT: '600000',
      MCP_TIMEOUT: '60000',
      ...this.config.env,
    };
  }

  private systemPromptPath(): string | undefined {
    const path = this.protocolPath;
    return path !== undefined && existsSync(path) ? path : undefined;
  }

  private mcpConfigPath(identity: IdentityEndpoints): string {
    return join(identity.configDir, 'mcp.json');
  }

  private hooksSettingsPath(identity: IdentityEndpoints): string {
    return join(identity.configDir, 'settings.json');
  }

  private buildMcpConfig(identity: IdentityEndpoints): unknown {
    return {
      mcpServers: {
        conductor: { type: 'http', url: identity.mcpUrl },
      },
    };
  }

  private buildHookSettings(identity: IdentityEndpoints): unknown {
    const command = `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- ${shellQuote(
      identity.eventsUrl,
    )} >/dev/null 2>&1 || true`;
    const hooks: Record<string, unknown> = {};
    for (const event of HOOK_EVENTS) {
      hooks[event] = [{ hooks: [{ type: 'command', command }] }];
    }
    return { hooks, ...(this.config.bareUi ? { spinnerTipsEnabled: false } : {}) };
  }
}
