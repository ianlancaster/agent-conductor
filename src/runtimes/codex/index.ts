import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionConfig, SupervisorConfig } from '../../config/schema.js';
import type { RuntimeEvent } from '../../core/types.js';
import type { SessionRuntime, IdentityEndpoints, InputState, LaunchOptions, RuntimeCapabilities } from '../types.js';
import { log } from '../../logger.js';
import {
  GENERATED_MARKER,
  buildConfigOverrides,
  renderAgentsOverride,
  renderNotifyScript,
  shellQuote,
  tomlString,
} from './config-gen.js';

export type CodexRuntimeSettings = SupervisorConfig['runtimes']['codex'];

export interface CodexRuntimeOptions {
  /** The `runtimes.codex` slice of the supervisor config. */
  config: CodexRuntimeSettings;
  /** Directory relative session paths (repo, additionalDirs) resolve against. */
  baseDir: string;
  /** Path to the conductor protocol prompt inlined into AGENTS.override.md. */
  protocolPath?: string;
}

const PROTOCOL_PLACEHOLDER =
  '<!-- conductor protocol placeholder: no protocolPath configured; the conductor supplies the real instructions -->';

const NOTIFY_SCRIPT_NAME = 'notify.sh';

/** Per-session CODEX_HOME lives here (isolates sessions/); auth is symlinked in from the shared home. */
const CODEX_HOME_DIR = 'codex-home';

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

/**
 * Envelope prefixes the conductor itself types into sessions. Codex echoes
 * submitted messages into the transcript with the same `›` prefix as the
 * composer, so a ›-row carrying one of OUR envelopes is delivery history, not
 * operator typing. These prefixes are conductor constants — not Codex UI text.
 */
const DELIVERED_ENVELOPE = /^\[(?:Message|Broadcast) from /u;

/**
 * Rows that may legitimately render BELOW the composer: the status footer
 * ("<model> <effort> · <cwd>"), shortcut hints, spinner, context meter. The
 * composer is only identifiable as the bottom-most content row above these —
 * any other content row at the bottom means the composer is not visible.
 */
const BELOW_COMPOSER_CHROME: readonly RegExp[] = [
  / · /u, // status footer separator
  /[⏎⌃↑↓⇧]/u, // shortcut hint rows (⏎ send, ⌃J newline, …)
  /esc to interrupt/iu,
  /\d+%\s+context\s+left/iu,
  /messages to be submitted after next tool call/iu, // steering-queue hint
];

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
    // EventMsg-style session message: {"type":"agent_message","message":"..."}
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
 * Identity and hooks ride entirely on `-c` CLI overrides (per-session MCP URL,
 * notify hook, approvals bypass), so the operator's `~/.codex` auth and config
 * are never touched. Protocol instructions are injected by writing
 * `<repo>/AGENTS.override.md`, which Codex loads with absolute precedence over
 * `AGENTS.md` at the repo root — the generated file re-embeds the repo's own
 * AGENTS.md so no guidance is lost.
 */
export class CodexRuntime implements SessionRuntime {
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

  async prepare(session: SessionConfig, identity: IdentityEndpoints): Promise<void> {
    // A relaunch rolls a fresh composer ghost hint — forget the old one.
    this.ghostText.delete(session.codename);
    const repo = this.resolvePath(session.repo);
    await mkdir(identity.configDir, { recursive: true });
    await writeFile(this.notifyScriptPath(identity), renderNotifyScript(identity.eventsUrl), { mode: 0o755 });
    await this.prepareCodexHome(identity, repo);

    const protocolText = await this.readProtocolText();
    const overridePath = path.join(repo, 'AGENTS.override.md');

    const existingOverride = await this.readIfExists(overridePath);
    if (existingOverride !== null && !existingOverride.includes(GENERATED_MARKER)) {
      log().warn(
        'codex',
        `${overridePath} exists and was not generated by the conductor; leaving it untouched — ` +
          'conductor protocol instructions will NOT be injected for this session',
      );
      return;
    }

    const existingAgentsMd = await this.readIfExists(path.join(repo, 'AGENTS.md'));
    const sessionPromptText =
      session.systemPromptFile !== undefined
        ? await this.readIfExists(this.resolvePath(session.systemPromptFile))
        : null;
    await writeFile(overridePath, renderAgentsOverride(protocolText, existingAgentsMd, sessionPromptText));
  }

  buildLaunchCommand(session: SessionConfig, identity: IdentityEndpoints, opts: LaunchOptions): string {
    const repo = this.resolvePath(session.repo);
    const parts: string[] = [shellQuote(this.settings.binary)];
    // `resume --last` picks the newest rollout in CODEX_HOME/sessions. With a
    // per-session CODEX_HOME that set only ever contains THIS session's sessions, so
    // a continue can't accidentally resume another codex session's (or the
    // operator's own) session.
    if (opts.continueSession === true) parts.push('resume', '--last');

    const overrides = buildConfigOverrides({
      mcpUrl: identity.mcpUrl,
      notifyCommand: ['/bin/sh', this.notifyScriptPath(identity)],
      toolTimeoutSec: this.settings.toolTimeoutSec,
      bareUi: this.settings.bareUi,
    });
    for (const override of overrides) parts.push('-c', shellQuote(override));

    parts.push('--dangerously-bypass-approvals-and-sandbox');

    const model = session.model ?? this.settings.defaultModel;
    if (model !== undefined) parts.push('--model', shellQuote(model));

    for (const dir of session.additionalDirs) parts.push('--add-dir', shellQuote(this.resolvePath(dir)));

    if (opts.prompt !== undefined) parts.push('--', shellQuote(opts.prompt));

    const codexHome = this.codexHomePath(identity);
    return `cd ${shellQuote(repo)} && export CODEX_HOME=${shellQuote(codexHome)} && ${parts.join(' ')}`;
  }

  /**
   * An EMPTY Codex composer shows ghost-text hints ("Use /skills to list
   * available skills", …) drawn from a pool that is hardcoded upstream — no
   * config disables it, and the pool drifts across versions, so pattern-matching
   * it is a losing game. Instead: Codex picks ONE hint per launch and never
   * changes it, so the first non-empty composer content seen for a session IS
   * that session's ghost text. Learn it, then treat only *different* content as
   * operator typing. prepare() resets the memory on every (re)launch.
   */
  private readonly ghostText = new Map<string, string>();

  /**
   * The composer is the `›` row sitting directly above the footer/hint chrome.
   * Empty, or showing this session's learned ghost hint, means clear; other
   * content means the operator is typing (never type over it — our deliveries
   * end with Enter and would submit the operator's draft). A ›-row bearing a
   * conductor envelope signature is indistinguishable from a TRANSCRIPT echo
   * of a past delivery (Codex renders both with `›`), and a bottom content row
   * that is not a ›-row means the composer is not visible — both are null
   * (cannot determine; delivery falls back to the readiness gate).
   */
  parseInputState(capture: string, session?: string): InputState {
    for (const line of capture.split('\n').reverse()) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (!trimmed.startsWith('›')) {
        if (BELOW_COMPOSER_CHROME.some((pattern) => pattern.test(trimmed))) continue;
        return null;
      }
      const content = trimmed.slice('›'.length).trim();
      if (content.length === 0) return 'clear';
      if (DELIVERED_ENVELOPE.test(content)) return null;
      if (session === undefined) return 'operator-draft';
      const known = this.ghostText.get(session);
      if (known === undefined) {
        this.ghostText.set(session, content);
        return 'clear';
      }
      return content === known ? 'clear' : 'operator-draft';
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
   * (an EXTERNAL protocol constant — "agent" is Codex's word, never rename it)
   * (fields are kebab-case: `turn-id`, `input-messages`, `last-assistant-message`).
   * It maps to a normalized `stop`; anything else is unrecognized.
   */
  parseEvent(body: unknown): Omit<RuntimeEvent, 'session' | 'receivedAt'> | null {
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
   * Create the per-session CODEX_HOME and symlink the shared home's auth/config
   * into it, so the session authenticates and inherits provider config while
   * keeping its own isolated `sessions/`. Symlink failures are non-fatal: a
   * missing shared auth.json just means the session relies on env-var auth.
   */
  private async prepareCodexHome(identity: IdentityEndpoints, repo: string): Promise<void> {
    const home = this.codexHomePath(identity);
    await mkdir(home, { recursive: true });
    const sharedHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');

    // auth.json stays a SYMLINK so token refreshes keep hitting the shared home.
    try {
      await symlink(path.join(sharedHome, 'auth.json'), path.join(home, 'auth.json'));
    } catch (err) {
      // EEXIST (already linked from a prior prepare) is fine and silent.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        log().debug('codex', `could not link auth.json into per-session CODEX_HOME: ${(err as Error).message}`);
      }
    }

    // config.toml is a per-launch COPY of the shared config with the session's
    // working directory pre-trusted. Codex only honors trust from the config
    // FILE (the -c override is ignored for the startup trust gate, which would
    // otherwise BLOCK the pane on an interactive prompt), and writing through a
    // symlink would mutate the operator's real config. Regenerated on every
    // launch, so shared-config edits are picked up on the next (re)start.
    const sharedConfig = (await this.readIfExists(path.join(sharedHome, 'config.toml'))) ?? '';
    const trustHeader = `[projects.${tomlString(repo)}]`;
    const trustEntry = sharedConfig.includes(trustHeader)
      ? ''
      : `\n# ${GENERATED_MARKER}: pre-trust the session working directory\n${trustHeader}\ntrust_level = "trusted"\n`;
    const configDest = path.join(home, 'config.toml');
    // May be a symlink from an earlier conductor version — remove, never write through it.
    await rm(configDest, { force: true });
    await writeFile(configDest, `${sharedConfig}${trustEntry}`);
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
