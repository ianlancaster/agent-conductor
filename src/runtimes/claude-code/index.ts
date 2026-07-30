import { constants, existsSync } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionConfig, SupervisorConfig } from '../../config/schema.js';
import type { PaneActivityEvidence, RuntimeEvent } from '../../core/types.js';
import { shellQuote } from '../../core/shell.js';
import type {
  SessionRuntime,
  IdentityEndpoints,
  InputState,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimePreparation,
} from '../types.js';
import {
  prepareInstructionLayers,
  PROTOCOL_SNAPSHOT_NAME,
  SESSION_INSTRUCTIONS_SNAPSHOT_NAME,
} from '../instructions.js';
import {
  hasClaudeSelectionPrompt,
  parseClaudeActivityState,
  parseClaudeInputState,
  stripClaudeChrome,
} from './chrome.js';
import { readLastAssistantMessage } from './transcript.js';

export type ClaudeCodeConfig = SupervisorConfig['runtimes']['claudeCode'];
export type ClaudePreToolUseConfig = Pick<ClaudeCodeConfig, 'preToolUseHooks'>;
type PreToolUseHook = ClaudeCodeConfig['preToolUseHooks'][number];

interface RenderedPreToolUseHook {
  matcher: string;
  hooks: { type: 'command'; command: string; timeout: number }[];
}

export interface ClaudePreToolUseDeclaration {
  hooksDeclared: boolean;
  renderedDigest?: string;
}

function effectivePreToolUseHooks(session: SessionConfig, config: ClaudePreToolUseConfig): PreToolUseHook[] {
  return session.claudeCode?.preToolUseHooks ?? config.preToolUseHooks;
}

function renderPreToolUseHooks(hooks: readonly PreToolUseHook[]): RenderedPreToolUseHook[] {
  return hooks.map((hook) => ({
    matcher: hook.matcher,
    hooks: [
      {
        type: 'command',
        command: [hook.command, ...hook.args].map(shellQuote).join(' '),
        timeout: hook.timeoutSec,
      },
    ],
  }));
}

function preToolUseDigest(rendered: readonly RenderedPreToolUseHook[]): string | undefined {
  if (rendered.length === 0) return undefined;
  const exactBlock = JSON.stringify({ PreToolUse: rendered });
  return createHash('sha256').update(exactBlock).digest('hex');
}

/** Current declaration for the next Claude Code launch; never runtime registration evidence. */
export function resolveClaudePreToolUseDeclaration(
  session: SessionConfig,
  config: ClaudePreToolUseConfig,
): ClaudePreToolUseDeclaration {
  const rendered = renderPreToolUseHooks(effectivePreToolUseHooks(session, config));
  return {
    hooksDeclared: rendered.length > 0,
    ...(rendered.length > 0 ? { renderedDigest: preToolUseDigest(rendered) } : {}),
  };
}

/** Hook events wired into every session. All POST their stdin JSON to the events endpoint. */
const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'Notification', 'PreCompact', 'SessionEnd', 'SessionStart'] as const;

/**
 * Claude fires one `Notification` hook for two unrelated conditions: a real
 * permission/approval prompt, and the idle timer that reports an empty composer
 * after roughly a minute. Only the first is a `blocked` stall. The second is
 * ordinary turn completion — it arrives on every seat that sits between tasks,
 * and treating it as blocked costs the sentinel a pane read each time, because
 * `blocked` is the one stall kind that cannot be dismissed mechanically.
 *
 * The hook payload carries no class field, so the message text is the only
 * discriminator available. Classification stays narrow: an unrecognized message
 * keeps the conservative `blocked` mapping rather than being assumed harmless.
 */
const IDLE_NOTIFICATION = /waiting for your input/iu;

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

  async prepare(session: SessionConfig, identity: IdentityEndpoints): Promise<RuntimePreparation> {
    const configuredHooks = effectivePreToolUseHooks(session, this.config);
    await this.validatePreToolUseCommands(configuredHooks);
    await mkdir(identity.configDir, { recursive: true });
    const protocolText =
      this.protocolPath !== undefined && existsSync(this.protocolPath)
        ? await readFile(this.protocolPath, 'utf8')
        : undefined;
    await prepareInstructionLayers({
      configDir: identity.configDir,
      protocolText,
      sessionSourcePath: session.systemPromptFile,
    });
    await writeFile(this.mcpConfigPath(identity), `${JSON.stringify(this.buildMcpConfig(identity), null, 2)}\n`);
    const renderedHooks = renderPreToolUseHooks(configuredHooks);
    await writeFile(
      this.hooksSettingsPath(identity),
      `${JSON.stringify(this.buildSessionSettings(session, identity, renderedHooks), null, 2)}\n`,
    );
    await seedFolderTrust(this.claudeJsonPath, session.repo);
    const hooksRenderedDigest = preToolUseDigest(renderedHooks);
    return hooksRenderedDigest === undefined ? {} : { hooksRenderedDigest };
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
    const promptFile = this.systemPromptPath(identity);
    if (promptFile !== undefined) {
      flags.push('--append-system-prompt-file', shellQuote(promptFile));
    }
    if (session.systemPromptFile !== undefined) {
      flags.push(
        '--append-system-prompt-file',
        shellQuote(join(identity.configDir, SESSION_INSTRUCTIONS_SNAPSHOT_NAME)),
      );
    }

    const claude = `${this.config.binary} ${flags.join(' ')}`;
    const launch =
      opts.prompt !== undefined && !opts.continueSession ? `echo ${shellQuote(opts.prompt)} | ${claude}` : claude;
    parts.push(launch);
    return parts.join(' && ');
  }

  resolveLaunchModel(session: SessionConfig): string | undefined {
    return session.model ?? this.config.defaultModel;
  }

  parseInputState(capture: string): InputState {
    return parseClaudeInputState(capture);
  }

  hasBlockingPrompt(capture: string): boolean {
    return hasClaudeSelectionPrompt(capture);
  }

  parseActivityState(capture: string): PaneActivityEvidence {
    return parseClaudeActivityState(capture);
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
    const message = typeof record.message === 'string' ? record.message : undefined;
    const type =
      hookEvent === 'Notification' && message !== undefined && IDLE_NOTIFICATION.test(message)
        ? // Waiting at an empty composer is completion evidence, not a block. It
          // takes the same debounced, dedupable `idle` path as a `Stop` hook, so
          // it also repairs a completion hook that was never delivered.
          'stop'
        : EVENT_MAP[hookEvent];
    if (type === undefined) return null;
    return {
      type,
      reason: message,
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
      // The percentage above is inert on its own: Claude Code checks whether a
      // window was configured explicitly before it consults the percentage, and
      // returns early when the window source is automatic. Setting both is what
      // actually arms auto-compaction.
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(this.config.autocompactWindowTokens),
      ...(this.config.disableNonessentialTraffic ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {}),
      // Plain iTerm capture cannot distinguish prompt suggestions from real
      // typed input. Disable them in every Conductor session so only a truly
      // empty composer can authorize protected delivery. IS_DEMO remains the
      // broader bare-UI switch; spinner tips are handled in settings.
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
      // IS_DEMO does NOT suppress the `statusLine` command: measured across eight
      // seats running with IS_DEMO=1 and a rendering footer, and in an A/B with
      // the variable set explicitly rather than inherited. Recorded because the
      // opposite was believed for a while on one clean-looking observation, and
      // it nearly bought a config knob that was not needed.
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

  private systemPromptPath(identity: IdentityEndpoints): string | undefined {
    const path = join(identity.configDir, PROTOCOL_SNAPSHOT_NAME);
    return existsSync(path) ? path : undefined;
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

  /**
   * The per-session settings file passed as `--settings`, which Claude Code
   * loads into its `flagSettings` layer. `askUserQuestionTimeout` is resolved
   * from `policySettings`, `flagSettings` and `userSettings` only — not project
   * or local settings — so this generated file is the one place Conductor can
   * set it per session. Writing it to user settings instead would apply it to
   * every Claude Code session on the machine, managed or not.
   */
  private buildSessionSettings(
    session: SessionConfig,
    identity: IdentityEndpoints,
    preToolUseHooks: readonly RenderedPreToolUseHook[],
  ): unknown {
    const command = `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- ${shellQuote(
      identity.eventsUrl,
    )} >/dev/null 2>&1 || true`;
    const hooks: Record<string, unknown> = {};
    for (const event of HOOK_EVENTS) {
      hooks[event] = [{ hooks: [{ type: 'command', command }] }];
    }
    if (preToolUseHooks.length > 0) hooks.PreToolUse = preToolUseHooks;
    return {
      hooks,
      // Bounds an unanswered question rather than letting it park the seat. A
      // selection prompt blocks the turn and Conductor must not answer it — its
      // free-text option is indistinguishable from a composer, and typing there
      // answers a question nobody asked Conductor to answer — so without a
      // timeout the only exit is a human.
      askUserQuestionTimeout: session.askUserQuestionTimeout ?? this.config.askUserQuestionTimeout,
      ...(this.config.bareUi ? { spinnerTipsEnabled: false } : {}),
    };
  }

  private async validatePreToolUseCommands(hooks: readonly PreToolUseHook[]): Promise<void> {
    for (const hook of hooks) {
      try {
        const info = await stat(hook.command);
        if (!info.isFile()) throw new Error('not a file');
        await access(hook.command, constants.X_OK);
      } catch {
        throw new Error(`PreToolUse hook command is missing or not executable: ${hook.command}`);
      }
    }
  }
}
