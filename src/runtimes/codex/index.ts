import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentConfig, SupervisorConfig } from '../../config/schema.js';
import type { RuntimeEvent } from '../../core/types.js';
import type { AgentRuntime, IdentityEndpoints, LaunchOptions, RuntimeCapabilities } from '../types.js';
import { log } from '../../logger.js';
import {
  GENERATED_MARKER,
  buildConfigOverrides,
  renderAgentsOverride,
  renderNotifyScript,
  shellQuote,
} from './config-gen.js';

export type CodexRuntimeSettings = SupervisorConfig['runtimes']['codex'];

export interface CodexRuntimeOptions {
  /** The `runtimes.codex` slice of the supervisor config. */
  config: CodexRuntimeSettings;
  /** Directory relative agent paths (repo, additionalDirs) resolve against. */
  baseDir: string;
  /** Path to the conductor protocol prompt inlined into AGENTS.override.md. */
  protocolPath?: string;
}

const PROTOCOL_PLACEHOLDER =
  '<!-- conductor protocol placeholder: no protocolPath configured; the conductor supplies the real instructions -->';

const NOTIFY_SCRIPT_NAME = 'notify.sh';

/** Per-agent CODEX_HOME lives here (isolates sessions/); auth is symlinked in from the shared home. */
const CODEX_HOME_DIR = 'codex-home';

/** Files symlinked from the shared codex home so a per-agent home still authenticates and inherits config. */
const SHARED_CODEX_FILES = ['auth.json', 'config.toml'] as const;

/**
 * TUI chrome patterns (Codex CLI, ratatui-based). The composer prompt row
 * starts with `›`; below it Codex renders shortcut hints (`⏎ send`,
 * `Ctrl+J newline`, …), a context meter (`NN% context left`), and while a
 * turn is running a spinner row (`• Working (3s • esc to interrupt)`).
 */
const CHROME_PATTERNS: readonly RegExp[] = [
  /^\s*›/u, // composer input row
  /esc to interrupt/iu, // working spinner / interrupt hint
  /\d+%\s+context\s+left/iu, // context meter
  /[⏎⌃↑↓⇧]/u, // shortcut hint rows (⏎ send, ⌃J newline, …)
  /^\s*[•▌·]?\s*Working\b/u, // spinner row variants
  /^\s*Tokens?\s+used:/iu, // token usage footer
  /messages to be submitted after next tool call/iu, // steering-queue hint
];

/** Composer placeholder texts shown when the input is empty. */
const COMPOSER_PLACEHOLDERS: readonly RegExp[] = [/^ask codex/iu, /^type a message/iu, /^implement, fix, or explain/iu];

interface ParsedNotifyPayload {
  readonly type: string;
  readonly record: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function parseNotifyPayload(body: unknown): ParsedNotifyPayload | null {
  const record = asRecord(body);
  if (record === null) return null;
  const type = record.type;
  if (typeof type !== 'string') return null;
  return { type, record };
}

/** Extract assistant text from one parsed rollout JSONL line, or null. */
function assistantTextFromRolloutLine(line: unknown): string | null {
  const record = asRecord(line);
  if (record === null) return null;
  // Rollout lines wrap payloads: {"type":"response_item","payload":{...}}.
  // Be tolerant of unwrapped items too.
  const payload = asRecord(record.payload) ?? record;
  if (payload.role !== 'assistant') {
    // EventMsg-style agent message: {"type":"agent_message","message":"..."}
    if (payload.type === 'agent_message' && typeof payload.message === 'string') return payload.message;
    return null;
  }
  if (payload.type !== undefined && payload.type !== 'message') return null;
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const item of content) {
    const itemRecord = asRecord(item);
    if (itemRecord === null) continue;
    if (itemRecord.type !== 'output_text' && itemRecord.type !== 'text') continue;
    if (typeof itemRecord.text === 'string') texts.push(itemRecord.text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/**
 * OpenAI Codex CLI runtime.
 *
 * Identity and hooks ride entirely on `-c` CLI overrides (per-agent MCP URL,
 * notify hook, approvals bypass), so the operator's `~/.codex` auth and config
 * are never touched. Protocol instructions are injected by writing
 * `<repo>/AGENTS.override.md`, which Codex loads with absolute precedence over
 * `AGENTS.md` at the repo root — the generated file re-embeds the repo's own
 * AGENTS.md so no guidance is lost.
 */
export class CodexRuntime implements AgentRuntime {
  readonly name = 'codex';
  readonly capabilities: RuntimeCapabilities = { lifecycleEvents: true, contextProbe: false };

  private readonly settings: CodexRuntimeSettings;
  private readonly baseDir: string;
  private readonly protocolPath: string | undefined;

  constructor(opts: CodexRuntimeOptions) {
    this.settings = opts.config;
    this.baseDir = opts.baseDir;
    this.protocolPath = opts.protocolPath;
  }

  async prepare(agent: AgentConfig, identity: IdentityEndpoints): Promise<void> {
    await mkdir(identity.configDir, { recursive: true });
    await writeFile(this.notifyScriptPath(identity), renderNotifyScript(identity.eventsUrl), { mode: 0o755 });
    await this.prepareCodexHome(identity);

    const protocolText = await this.readProtocolText();
    const repo = this.resolvePath(agent.repo);
    const overridePath = path.join(repo, 'AGENTS.override.md');

    const existingOverride = await this.readIfExists(overridePath);
    if (existingOverride !== null && !existingOverride.includes(GENERATED_MARKER)) {
      log().warn(
        'codex',
        `${overridePath} exists and was not generated by the conductor; leaving it untouched — ` +
          'conductor protocol instructions will NOT be injected for this agent',
      );
      return;
    }

    const existingAgentsMd = await this.readIfExists(path.join(repo, 'AGENTS.md'));
    const agentPromptText =
      agent.systemPromptFile !== undefined ? await this.readIfExists(this.resolvePath(agent.systemPromptFile)) : null;
    await writeFile(overridePath, renderAgentsOverride(protocolText, existingAgentsMd, agentPromptText));
  }

  buildLaunchCommand(agent: AgentConfig, identity: IdentityEndpoints, opts: LaunchOptions): string {
    const repo = this.resolvePath(agent.repo);
    const parts: string[] = [shellQuote(this.settings.binary)];
    // `resume --last` picks the newest rollout in CODEX_HOME/sessions. With a
    // per-agent CODEX_HOME that set only ever contains THIS agent's sessions, so
    // a continue can't accidentally resume another codex agent's (or the
    // operator's own) session.
    if (opts.continueSession === true) parts.push('resume', '--last');

    const overrides = buildConfigOverrides({
      mcpUrl: identity.mcpUrl,
      notifyCommand: ['/bin/sh', this.notifyScriptPath(identity)],
      toolTimeoutSec: this.settings.toolTimeoutSec,
    });
    for (const override of overrides) parts.push('-c', shellQuote(override));

    parts.push('--dangerously-bypass-approvals-and-sandbox');

    const model = agent.model ?? this.settings.defaultModel;
    if (model !== undefined) parts.push('--model', shellQuote(model));

    for (const dir of agent.additionalDirs) parts.push('--add-dir', shellQuote(this.resolvePath(dir)));

    if (opts.prompt !== undefined) parts.push('--', shellQuote(opts.prompt));

    const codexHome = this.codexHomePath(identity);
    return `cd ${shellQuote(repo)} && export CODEX_HOME=${shellQuote(codexHome)} && ${parts.join(' ')}`;
  }

  /**
   * The Codex composer is the row starting with `›`. Empty (or showing only a
   * placeholder like "Ask Codex …") means clear; any other trailing text means
   * the operator is typing. No composer row in the capture → null (cannot
   * determine — e.g. an overlay or transcript view owns the screen).
   */
  parseInputClear(capture: string): boolean | null {
    const lines = capture.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === undefined) continue;
      const trimmed = line.trim();
      if (!trimmed.startsWith('›')) continue;
      const content = trimmed.slice('›'.length).trim();
      if (content.length === 0) return true;
      if (COMPOSER_PLACEHOLDERS.some((pattern) => pattern.test(content))) return true;
      return false;
    }
    return null;
  }

  stripChrome(capture: string): string {
    const kept = capture.split('\n').filter((line) => !CHROME_PATTERNS.some((pattern) => pattern.test(line)));
    while (kept.length > 0 && (kept[kept.length - 1] ?? '').trim().length === 0) kept.pop();
    return kept.join('\n');
  }

  /**
   * Codex notify currently emits a single event type, `agent-turn-complete`
   * (fields are kebab-case: `turn-id`, `input-messages`, `last-assistant-message`).
   * It maps to a normalized `stop`; anything else is unrecognized.
   */
  parseEvent(body: unknown): Omit<RuntimeEvent, 'agent' | 'receivedAt'> | null {
    const payload = parseNotifyPayload(body);
    if (payload === null) return null;
    if (payload.type !== 'agent-turn-complete') return null;
    return {
      type: 'stop',
      reason: stringField(payload.record, 'last-assistant-message', 'last_assistant_message'),
      transcriptPath: stringField(payload.record, 'transcript-path', 'transcript_path', 'rollout-path'),
    };
  }

  /**
   * Codex persists sessions as rollout JSONL under
   * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; each line wraps a payload
   * (`{"type":"response_item","payload":{"type":"message","role":"assistant",
   * "content":[{"type":"output_text","text":"…"}]}}`). Returns the text of the
   * last assistant message, or null if the file is missing/unparseable.
   */
  async readLastAssistantMessage(transcriptPath: string): Promise<string | null> {
    let raw: string;
    try {
      raw = await readFile(transcriptPath, 'utf8');
    } catch {
      return null;
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === undefined || line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const text = assistantTextFromRolloutLine(parsed);
      if (text !== null) return text;
    }
    return null;
  }

  private resolvePath(p: string): string {
    return path.resolve(this.baseDir, p);
  }

  private notifyScriptPath(identity: IdentityEndpoints): string {
    return path.join(identity.configDir, NOTIFY_SCRIPT_NAME);
  }

  private codexHomePath(identity: IdentityEndpoints): string {
    return path.join(identity.configDir, CODEX_HOME_DIR);
  }

  /**
   * Create the per-agent CODEX_HOME and symlink the shared home's auth/config
   * into it, so the agent authenticates and inherits provider config while
   * keeping its own isolated `sessions/`. Symlink failures are non-fatal: a
   * missing shared auth.json just means the agent relies on env-var auth.
   */
  private async prepareCodexHome(identity: IdentityEndpoints): Promise<void> {
    const home = this.codexHomePath(identity);
    await mkdir(home, { recursive: true });
    const sharedHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
    for (const file of SHARED_CODEX_FILES) {
      const src = path.join(sharedHome, file);
      const dest = path.join(home, file);
      try {
        await symlink(src, dest);
      } catch (err) {
        // EEXIST (already linked from a prior prepare) is fine and silent.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          log().debug('codex', `could not link ${file} into per-agent CODEX_HOME: ${(err as Error).message}`);
        }
      }
    }
  }

  private async readProtocolText(): Promise<string> {
    if (this.protocolPath === undefined) return PROTOCOL_PLACEHOLDER;
    const text = await this.readIfExists(this.resolvePath(this.protocolPath));
    if (text === null) {
      log().warn('codex', `protocol file not found at ${this.protocolPath}; using placeholder`);
      return PROTOCOL_PLACEHOLDER;
    }
    return text;
  }

  private async readIfExists(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }
}
