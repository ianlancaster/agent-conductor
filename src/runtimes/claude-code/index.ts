import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionConfig, SupervisorConfig } from '../../config/schema.js';
import type { PaneActivityEvidence, RuntimeEvent } from '../../core/types.js';
import { shellQuote } from '../../core/shell.js';
import { resolveTrustPaths } from '../../core/trust-paths.js';
import type { SessionRuntime, IdentityEndpoints, InputState, LaunchOptions, RuntimeCapabilities } from '../types.js';
import {
  appendProtocolNotice,
  prepareInstructionLayers,
  type PreparedInstructionLayers,
  type ProtocolNotice,
  writeAtomicFile,
} from '../instructions.js';
import {
  cleanupContinuityReaderGenerations,
  parseContinuityRestorationEvent,
  prepareContinuityStateSource,
  writeContinuityReaderGeneration,
} from '../continuity-state.js';
import { parseClaudeActivityState, parseClaudeInputState, stripClaudeChrome } from './chrome.js';
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

/**
 * The one file passed to --append-system-prompt-file. Claude Code keeps only
 * the last occurrence of that flag, so separate files would silently drop
 * every layer but the protocol.
 */
export const LAUNCH_SYSTEM_PROMPT_NAME = 'system-prompt.md';

/**
 * Join the prepared layers in their documented order: session instructions,
 * then the mandatory protocol last. Each layer was size-checked on its own;
 * the combination is never truncated.
 */
async function writeLaunchSystemPrompt(configDir: string, layers: PreparedInstructionLayers): Promise<void> {
  const path = join(configDir, LAUNCH_SYSTEM_PROMPT_NAME);
  const parts = [layers.session?.content, layers.protocol?.content].filter(
    (content): content is string => content !== undefined,
  );
  if (parts.length === 0) await rm(path, { force: true });
  else await writeAtomicFile(path, parts.join('\n'), 0o600);
}

export interface ClaudeCodeRuntimeOptions {
  config: ClaudeCodeConfig;
  /** Path to the conductor protocol prompt appended to every session's system prompt. */
  protocolPath?: string;
  /** Optional fleet capability hint appended to the managed protocol. */
  protocolNotice?: ProtocolNotice;
  /** Override Claude's state path when embedding the runtime (primarily for isolated tests). */
  claudeJsonPath?: string;
}

/**
 * Pre-accept Claude Code's folder-trust dialog for a session's repo.
 * `--dangerously-skip-permissions` does NOT cover the separate trust gate, so
 * a freshly-spawned directory otherwise boots into "do you trust this
 * folder?" and sits not-ready until someone answers — and Claude Code does
 * not run project `.claude/settings.json` hooks in an untrusted workspace
 * either, so an unseeded/mis-seeded entry silently drops hooks rather than
 * just showing a dialog. Best-effort: a corrupt or unwritable `.claude.json`
 * must never block a launch.
 *
 * `paths` should be every location Claude Code might resolve THIS session's
 * project to — see `resolveTrustPaths` — since Claude compares resolved
 * paths and applies trust at the Git repository root, not necessarily the
 * literal cwd.
 */
export async function seedFolderTrust(claudeJsonPath: string, paths: readonly string[]): Promise<void> {
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
    let changed = false;
    for (const repoPath of paths) {
      const entry =
        typeof projects[repoPath] === 'object' && projects[repoPath] !== null
          ? (projects[repoPath] as Record<string, unknown>)
          : {};
      if (entry.hasTrustDialogAccepted === true) continue;
      entry.hasTrustDialogAccepted = true;
      projects[repoPath] = entry;
      changed = true;
    }
    if (!changed) return;
    root.projects = projects;
    await mkdir(dirname(claudeJsonPath), { recursive: true });
    await writeAtomicFile(claudeJsonPath, JSON.stringify(root, null, 2), 0o600);
  } catch (err) {
    // Never let trust seeding break a launch.
    void err;
  }
}

export class ClaudeCodeRuntime implements SessionRuntime {
  readonly name: string = 'claude-code';
  readonly capabilities: RuntimeCapabilities = {
    lifecycleEvents: true,
    targetedResume: true,
    authoritativeTurnCompletion: true,
    contextProbe: true,
    continuityState: true,
    styledCapture: false,
  };

  private readonly config: ClaudeCodeConfig;
  private readonly protocolPath: string | undefined;
  private readonly protocolNotice: ProtocolNotice | undefined;
  private readonly claudeJsonPath: string;

  constructor(opts: ClaudeCodeRuntimeOptions) {
    this.config = opts.config;
    this.protocolPath = opts.protocolPath;
    this.protocolNotice = opts.protocolNotice;
    this.claudeJsonPath = opts.claudeJsonPath ?? join(homedir(), '.claude.json');
  }

  async prepare(session: SessionConfig, identity: IdentityEndpoints): Promise<void> {
    await mkdir(identity.configDir, { recursive: true });
    const continuityState =
      session.continuityStateFile === undefined
        ? undefined
        : await prepareContinuityStateSource(session.continuityStateFile);
    const sourceProtocolText =
      this.protocolPath !== undefined && existsSync(this.protocolPath)
        ? await readFile(this.protocolPath, 'utf8')
        : undefined;
    const protocolText =
      sourceProtocolText === undefined ? undefined : appendProtocolNotice(sourceProtocolText, this.protocolNotice);
    const layers = await prepareInstructionLayers({
      configDir: identity.configDir,
      protocolText,
      sessionSourcePath: session.systemPromptFile,
    });
    await writeLaunchSystemPrompt(identity.configDir, layers);
    const continuityReader =
      continuityState === undefined
        ? undefined
        : await writeContinuityReaderGeneration(identity.configDir, {
            prepared: continuityState,
            eventsUrl: identity.eventsUrl,
          });
    await writeAtomicFile(
      this.mcpConfigPath(identity),
      `${JSON.stringify(this.buildMcpConfig(identity), null, 2)}\n`,
      0o600,
    );
    await writeAtomicFile(
      this.hooksSettingsPath(identity),
      `${JSON.stringify(this.buildHookSettings(identity, continuityReader), null, 2)}\n`,
      0o600,
    );
    await cleanupContinuityReaderGenerations(identity.configDir, continuityReader);
    await seedFolderTrust(this.claudeJsonPath, await resolveTrustPaths(session.repo));
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
    if (opts.continueSession) {
      if (opts.resumeSessionId === undefined) flags.push('-c');
      else flags.push('--resume', shellQuote(opts.resumeSessionId));
    }
    if (opts.bypassPermissions === true) flags.push('--dangerously-skip-permissions');
    const model = session.model ?? this.config.defaultModel;
    if (model !== undefined) flags.push('--model', shellQuote(model));
    if (effort !== undefined) flags.push('--effort', shellQuote(effort));
    for (const dir of session.additionalDirs) {
      flags.push('--add-dir', shellQuote(dir));
    }
    flags.push('--mcp-config', shellQuote(this.mcpConfigPath(identity)));
    flags.push('--settings', shellQuote(this.hooksSettingsPath(identity)));
    // Claude Code honors only the last --append-system-prompt-file, so every
    // managed layer goes through one combined file. A configured session layer
    // always references it, so a launch without preparation fails visibly.
    const promptFile = join(identity.configDir, LAUNCH_SYSTEM_PROMPT_NAME);
    if (session.systemPromptFile !== undefined || existsSync(promptFile)) {
      flags.push('--append-system-prompt-file', shellQuote(promptFile));
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

  parseActivityState(capture: string): PaneActivityEvidence {
    return parseClaudeActivityState(capture);
  }

  stripChrome(capture: string): string {
    return stripClaudeChrome(capture);
  }

  parseEvent(body: unknown): Omit<RuntimeEvent, 'session' | 'receivedAt'> | null {
    if (typeof body !== 'object' || body === null) return null;
    const record = body as Record<string, unknown>;
    const continuity = parseContinuityRestorationEvent(record);
    if (continuity !== null) return continuity;
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
      ...(hookEvent === 'Notification' && typeof record.notification_type === 'string'
        ? { notificationType: record.notification_type }
        : {}),
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

  private buildHookSettings(identity: IdentityEndpoints, continuityReader?: string): unknown {
    const command = `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- ${shellQuote(
      identity.eventsUrl,
    )} >/dev/null 2>&1 || true`;
    const hooks: Record<string, unknown> = {};
    for (const event of HOOK_EVENTS) {
      if (event !== 'SessionStart') hooks[event] = [{ hooks: [{ type: 'command', command }] }];
    }
    hooks.SessionStart = [
      ...(continuityReader === undefined
        ? []
        : [
            {
              matcher: '^(startup|resume|compact)$',
              hooks: [
                {
                  type: 'command',
                  command: `${shellQuote(process.execPath)} ${shellQuote(continuityReader)}`,
                  timeout: 5,
                },
              ],
            },
          ]),
      { hooks: [{ type: 'command', command }] },
    ];
    return {
      hooks,
      ...(this.config.bareUi ? { spinnerTipsEnabled: false } : {}),
      // Conductor is the only messaging substrate. Claude Code has no environment variable for
      // this; its documented off switch is settings: deny the send and list tools and refuse
      // inbound peer messages (https://code.claude.com/docs/en/cross-session-messaging).
      ...(this.config.nativeAgentMessaging
        ? {}
        : { permissions: { deny: ['SendMessage', 'ListAgents'] }, crossSessionInbound: 'refuse' }),
    };
  }
}
