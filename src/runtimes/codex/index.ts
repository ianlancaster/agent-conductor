import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SessionConfig, SupervisorConfig } from '../../config/schema.js';
import type { PaneActivityEvidence, RuntimeEvent } from '../../core/types.js';
import type { SessionRuntime, IdentityEndpoints, InputState, LaunchOptions, RuntimeCapabilities } from '../types.js';
import { prepareInstructionLayers, writeAtomicFile } from '../instructions.js';
import { log } from '../../logger.js';
import {
  GENERATED_MARKER,
  PROJECT_DOC_HEADROOM_BYTES,
  REPOSITORY_DOC_BUDGET_BYTES,
  buildConfigOverrides,
  ensureProjectDocMaxBytes,
  isGeneratedAgentsOverride,
  readProjectDocMaxBytes,
  removeConductorInstructions,
  renderHomeAgentsOverride,
  renderLifecycleHookScript,
  renderNotifyScript,
  renderProtocolHooks,
  renderProtocolReminderScript,
  shellQuote,
  tomlString,
} from './config-gen.js';

export type CodexRuntimeSettings = SupervisorConfig['runtimes']['codex'];

export interface CodexRuntimeOptions {
  /** The `runtimes.codex` slice of the supervisor config. */
  config: CodexRuntimeSettings;
  /** Directory relative session paths (repo, additionalDirs) resolve against. */
  baseDir: string;
  /** Path to the conductor protocol prompt inlined into the session's home instructions. */
  protocolPath?: string;
  /** Fleet data/sessions directory, used to inspect this runtime's isolated rollout. */
  sessionDataDir?: string;
}

const PROTOCOL_PLACEHOLDER =
  '<!-- conductor protocol placeholder: no protocolPath configured; the conductor supplies the real instructions -->';

const NOTIFY_SCRIPT_NAME = 'notify.sh';
const LIFECYCLE_HOOK_SCRIPT_NAME = 'lifecycle-hook.mjs';
const PROTOCOL_REMINDER_SCRIPT_NAME = 'protocol-reminder.mjs';
const AGENTS_OVERRIDE_NAME = 'AGENTS.override.md';
const HOOKS_NAME = 'hooks.json';
const AGENTS_NAME = 'AGENTS.md';
const GIT_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

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
 * One visible character of a styled capture line, with whether the SGR dim
 * attribute (2) was active where it rendered.
 */
interface StyledChar {
  ch: string;
  dim: boolean;
}

/**
 * Apply one SGR parameter list to the dim flag. Extended-color introducers
 * (38/48/58) consume their arguments so a color component like `38;5;2`
 * can never read as the dim attribute.
 */
function applySgrParams(params: string, dim: boolean): boolean {
  const parts = params.length === 0 ? ['0'] : params.split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    const code = part.split(':')[0] ?? '';
    if (code === '38' || code === '48' || code === '58') {
      if (part.includes(':')) continue; // colon form carries its args in this part
      const mode = parts[i + 1];
      i += mode === '2' ? 4 : mode === '5' ? 2 : 0;
      continue;
    }
    if (code === '' || code === '0') dim = false;
    else if (code === '2') dim = true;
    else if (code === '22') dim = false;
  }
  return dim;
}

/** Split a styled line into visible chars + their dim state, and its plain text. */
function parseStyledLine(line: string): { plain: string; chars: StyledChar[] } {
  const chars: StyledChar[] = [];
  let dim = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\u001b') {
      // Parse the CSI sequence after the ESC byte by hand (an ESC inside a
      // regex trips no-control-regex): `[`, params, then one final byte.
      if (line[i + 1] !== '[') {
        i += 1; // lone/unknown escape — skip the ESC byte
        continue;
      }
      const body = /^[0-9;:?]*/.exec(line.slice(i + 2))?.[0] ?? '';
      const final = line[i + 2 + body.length] ?? '';
      if (final === 'm') dim = applySgrParams(body, dim);
      i += 2 + body.length + final.length;
      continue;
    }
    chars.push({ ch: line[i] ?? '', dim });
    i += 1;
  }
  return { plain: chars.map((c) => c.ch).join(''), chars };
}

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

/**
 * Codex's built-in empty-composer prompts. iTerm's AppleScript capture strips
 * the dim style that normally proves these are placeholders, so the plain-text
 * fallback has to recognize the finite built-in pool. Unknown content remains
 * a draft; in particular, we never learn arbitrary first-seen text.
 */
const PLAIN_GHOST_HINTS: readonly RegExp[] = [
  /^What['’]s on your mind\?$/u,
  /^Explain this codebase$/u,
  /^Summarize recent commits$/u,
  /^Implement \{feature\}$/u,
  /^Find and fix a bug in @filename$/u,
  /^Write tests for @filename$/u,
  /^Improve documentation in @filename$/u,
  /^Run \/review on my current changes$/u,
  /^Use \/skills to list available skills(?: or ask Codex to use one\.)?$/u,
  /^Check recently modified functions for compatibility$/u,
  /^How many files have been modified\?$/u,
  /^Will this algorithm scale well\?$/u,
];

interface ParsedNotifyPayload {
  readonly type: string;
  readonly record: Record<string, unknown>;
}

interface RolloutInputEvidence {
  idle: boolean;
  lastUserMessage: string | null;
}

interface CachedRolloutInputEvidence extends RolloutInputEvidence {
  path: string;
  size: number;
  mtimeMs: number;
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

/** Extract submitted user text from one rollout JSONL line, or null. */
function userTextFromRolloutLine(line: unknown): string | null {
  const record = asRecord(line);
  if (record === null) return null;
  const payload = asRecord(record.payload) ?? record;
  if (payload.type !== 'message' || payload.role !== 'user') return null;
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const item of content) {
    const itemRecord = asRecord(item);
    if (itemRecord === null || (itemRecord.type !== 'input_text' && itemRecord.type !== 'text')) continue;
    if (typeof itemRecord.text === 'string') texts.push(itemRecord.text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

function normalizeWrappedText(text: string): string {
  return text.replace(/\s+/gu, ' ').replace(/-\s+/gu, '-').trim();
}

function wrappedComparisonKey(text: string): string {
  // iTerm inserts capture-only whitespace when a long unbroken token (notably
  // a filesystem path) wraps at the terminal edge. Whitespace-free comparison
  // is safe here because both sides must still match at least 16 visible chars.
  return text.replace(/\s+/gu, '');
}

/**
 * Extract the bottom-most visible Codex input/transcript block without footer
 * chrome. iTerm inserts line breaks at terminal wrapping boundaries.
 */
function visibleInputBlock(capture: string): string | null {
  const lines = capture.split('\n');
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]?.trim() ?? '';
    if (line.length === 0 || BELOW_COMPOSER_CHROME.some((pattern) => pattern.test(line))) end -= 1;
    else break;
  }
  if (end === 0) return null;
  let start = end - 1;
  while (start >= 0 && !(lines[start]?.trimStart().startsWith('›') ?? false)) start -= 1;
  const promptVisible = start >= 0;
  // Delivery captures only the trailing pane rows. A long submitted message can
  // push its leading › outside that window, leaving only wrapped continuation
  // rows above the footer. Keep that suffix for rollout comparison; without an
  // exact submitted-message match the resolver still returns the blocked state.
  if (!promptVisible) start = 0;
  while (start < end && (lines[start]?.trim().length ?? 0) === 0) start += 1;
  if (start >= end) return null;
  const block = lines.slice(start, end);
  const first = block[0];
  if (first === undefined) return null;
  if (promptVisible) block[0] = first.trimStart().slice('›'.length);
  const normalized = normalizeWrappedText(block.join('\n'));
  return normalized.length > 0 ? normalized : null;
}

/**
 * OpenAI Codex CLI runtime.
 *
 * Identity, hooks, and instructions live in an isolated per-session CODEX_HOME.
 * The operator's shared auth/config and the consumer repository are never
 * mutated. The generated home override inherits the operator's active global
 * guidance, then appends the mandatory protocol and session instructions.
 */
export class CodexRuntime implements SessionRuntime {
  readonly name = 'codex';
  readonly capabilities: RuntimeCapabilities = {
    lifecycleEvents: true,
    authoritativeTurnCompletion: true,
    contextProbe: false,
    styledCapture: true,
  };

  private readonly settings: CodexRuntimeSettings;
  private readonly baseDir: string;
  private readonly protocolPath: string | undefined;
  private readonly sessionDataDir: string | undefined;
  private readonly rolloutInputCache = new Map<string, CachedRolloutInputEvidence>();

  constructor(opts: CodexRuntimeOptions) {
    this.settings = opts.config;
    this.baseDir = opts.baseDir;
    this.protocolPath = opts.protocolPath;
    this.sessionDataDir = opts.sessionDataDir;
  }

  async prepare(session: SessionConfig, identity: IdentityEndpoints): Promise<void> {
    const repo = this.resolvePath(session.repo);
    await mkdir(identity.configDir, { recursive: true });
    const protocolText = await this.readProtocolText();
    let reminderScript: string | undefined;
    const preparedInstructions = await prepareInstructionLayers({
      configDir: identity.configDir,
      protocolText,
      sessionSourcePath:
        session.systemPromptFile === undefined ? undefined : this.resolvePath(session.systemPromptFile),
      validate: (layers) => {
        reminderScript = renderProtocolReminderScript(
          layers.protocol?.content ?? protocolText,
          layers.session?.content ?? null,
        );
      },
    });
    const preparedProtocolText = preparedInstructions.protocol?.content ?? protocolText;
    const sessionPromptText = preparedInstructions.session?.content ?? null;
    const sharedHome = this.sharedCodexHome();
    const inheritedGuidance = await this.readActiveGlobalGuidance(sharedHome);
    const rendered = renderHomeAgentsOverride(inheritedGuidance, preparedProtocolText, sessionPromptText);
    if (rendered.inheritedGuidanceTruncated) {
      log().warn(
        'codex',
        `global Codex guidance was too large for ${session.codename}; the per-session copy was shortened while mandatory instructions were preserved`,
      );
    }
    const minimumDocBytes =
      Buffer.byteLength(rendered.content, 'utf8') + REPOSITORY_DOC_BUDGET_BYTES + PROJECT_DOC_HEADROOM_BYTES;
    await this.prepareCodexHome(identity, repo, sharedHome, minimumDocBytes);
    await writeAtomicFile(this.notifyScriptPath(identity), renderNotifyScript(identity.eventsUrl), 0o700);
    const homeOverridePath = path.join(this.codexHomePath(identity), AGENTS_OVERRIDE_NAME);
    await writeAtomicFile(homeOverridePath, rendered.content, 0o600);
    await writeAtomicFile(this.lifecycleHookScriptPath(identity), renderLifecycleHookScript(identity.eventsUrl), 0o700);
    await writeAtomicFile(
      this.protocolReminderScriptPath(identity),
      reminderScript ?? renderProtocolReminderScript(preparedProtocolText, sessionPromptText),
      0o700,
    );
    await writeFile(
      path.join(this.codexHomePath(identity), HOOKS_NAME),
      renderProtocolHooks(
        `${shellQuote(process.execPath)} ${shellQuote(this.protocolReminderScriptPath(identity))}`,
        `${shellQuote(process.execPath)} ${shellQuote(this.lifecycleHookScriptPath(identity))}`,
      ),
    );
    await this.warnForProjectDocLimit(repo, minimumDocBytes);
    await this.cleanupLegacyRepoOverride(repo);
  }

  buildLaunchCommand(session: SessionConfig, identity: IdentityEndpoints, opts: LaunchOptions): string {
    const repo = this.resolvePath(session.repo);
    const parts: string[] = [shellQuote(this.settings.binary)];
    // `resume --last` picks the newest rollout in CODEX_HOME/sessions. With a
    // per-session CODEX_HOME that set only ever contains THIS session's sessions, so
    // a continue can't accidentally resume another codex session's (or the
    // operator's own) session. An explicit ID deliberately selects that rollout.
    if (opts.continueSession === true) {
      parts.push('resume', opts.resumeSessionId === undefined ? '--last' : shellQuote(opts.resumeSessionId));
    }

    const effort = opts.effort ?? session.effort ?? this.settings.defaultEffort;
    const overrides = buildConfigOverrides({
      mcpUrl: identity.mcpUrl,
      notifyCommand: ['/bin/sh', this.notifyScriptPath(identity)],
      toolTimeoutSec: this.settings.toolTimeoutSec,
      bypassPermissions: opts.bypassPermissions === true,
      bareUi: this.settings.bareUi,
      effort,
    });
    for (const override of overrides) parts.push('-c', shellQuote(override));

    if (opts.bypassPermissions === true) parts.push('--dangerously-bypass-approvals-and-sandbox');
    if (this.settings.bypassHookTrust === true) parts.push('--dangerously-bypass-hook-trust');

    const model = session.model ?? this.settings.defaultModel;
    if (model !== undefined) parts.push('--model', shellQuote(model));

    for (const dir of session.additionalDirs) parts.push('--add-dir', shellQuote(this.resolvePath(dir)));

    if (opts.prompt !== undefined) parts.push('--', shellQuote(opts.prompt));

    const codexHome = this.codexHomePath(identity);
    return `cd ${shellQuote(repo)} && export CODEX_HOME=${shellQuote(codexHome)} && ${parts.join(' ')}`;
  }

  /**
   * The composer is the `›` row sitting directly above the footer/hint chrome.
   * Styled captures (tmux `-e`) make classification DETERMINISTIC — Codex's
   * own rendering distinguishes every case (verified against 0.144.x):
   *
   *   composer glyph   `ESC[1m›ESC[0m`      bold          — the live input line
   *   transcript glyph `ESC[1;2m› ESC[0m`   bold+dim      — history echo, composer hidden
   *   ghost hint       `ESC[2m…ESC[0m`      dim content   — EMPTY composer
   *   operator text    unstyled content                    — a human composing
   *
   * Plain captures (iTerm) cannot distinguish dim placeholder text from typed
   * input, so they recognize only Codex's exact built-in placeholder strings.
   * All other non-empty content is conservatively blocked. Envelope signatures
   * have no special status.
   */
  parseInputState(capture: string, session?: string): InputState {
    return capture.includes('\u001b[')
      ? this.parseStyledInputState(capture)
      : this.parsePlainInputState(capture, session);
  }

  parseActivityState(capture: string, session?: string): PaneActivityEvidence {
    // Codex deliberately keeps its composer available for steering while the
    // current turn runs. The spinner/interrupt row is execution evidence and
    // therefore takes precedence over a visible clear or occupied composer.
    if (/^\s*[•▌·]?\s*Working\s*\(/imu.test(capture)) return 'working' as const;
    return this.parseInputState(capture, session) === null ? ('unknown' as const) : ('idle' as const);
  }

  private parseStyledInputState(capture: string): InputState {
    for (const raw of capture.split('\n').reverse()) {
      const { plain, chars } = parseStyledLine(raw);
      const trimmed = plain.trim();
      if (trimmed.length === 0) continue;
      if (!trimmed.startsWith('›')) {
        if (BELOW_COMPOSER_CHROME.some((pattern) => pattern.test(trimmed))) continue;
        return null;
      }
      const glyphIdx = chars.findIndex((c) => c.ch === '›');
      const glyph = chars[glyphIdx];
      if (glyph === undefined) return null;
      if (glyph.dim) return null; // transcript echo — the composer is not on screen
      const content = chars.slice(glyphIdx + 1).filter((c) => c.ch.trim().length > 0);
      if (content.length === 0) return 'clear';
      if (content.every((c) => c.dim)) return 'clear'; // ghost hint — dim placeholder in an empty composer
      return 'draft';
    }
    return null;
  }

  private parsePlainInputState(capture: string, session?: string): InputState {
    for (const line of capture.split('\n').reverse()) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (!trimmed.startsWith('›')) {
        if (BELOW_COMPOSER_CHROME.some((pattern) => pattern.test(trimmed))) continue;
        return null;
      }
      const content = trimmed.slice('›'.length).trim();
      if (content.length === 0) return 'clear';
      if (session !== undefined && PLAIN_GHOST_HINTS.some((pattern) => pattern.test(content))) return 'clear';
      return 'draft';
    }
    return null;
  }

  async resolveInputState(capture: string, session: string, parsed: InputState): Promise<InputState> {
    if (parsed === 'clear' || capture.includes('\u001b[') || this.sessionDataDir === undefined) return parsed;
    // A visible spinner is authoritative: submitted text may match the rollout,
    // but Codex is still processing it and the composer is not available.
    if (/\bWorking\b|esc to interrupt/iu.test(capture)) return parsed;

    const visible = visibleInputBlock(capture);
    if (visible === null || visible.length < 16) return parsed;
    const evidence = await this.readRolloutInputEvidence(session);
    if (!evidence.idle || evidence.lastUserMessage === null) return parsed;
    const submitted = wrappedComparisonKey(evidence.lastUserMessage);
    const visibleKey = wrappedComparisonKey(visible);
    // Captures are tail-limited, so a very long submitted row may show only a
    // prefix or suffix. Requiring 16 visible characters avoids treating short,
    // coincidental operator drafts as transcript proof.
    return submitted === visibleKey || submitted.startsWith(visibleKey) || submitted.endsWith(visibleKey)
      ? 'clear'
      : parsed;
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
    const hook = asRecord(body);
    const hookName = hook === null ? undefined : stringField(hook, 'hook_event_name');
    if (hookName === 'UserPromptSubmit') {
      return { type: 'turn-start', turnId: stringField(hook ?? {}, 'turn_id', 'turn-id') };
    }
    if (hookName === 'PreCompact') {
      return {
        type: 'compaction',
        transcriptPath: stringField(hook ?? {}, 'transcript_path'),
      };
    }
    if (hookName === 'SessionStart') {
      return { type: hook?.source === 'compact' ? 'compaction-complete' : 'session-start' };
    }

    const payload = parseNotifyPayload(body);
    if (payload === null) return null;
    if (payload.type !== 'agent-turn-complete') return null;
    return {
      type: 'stop',
      turnId: stringField(payload.record, 'turn-id', 'turn_id'),
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

  private protocolReminderScriptPath(identity: IdentityEndpoints): string {
    return path.join(identity.configDir, PROTOCOL_REMINDER_SCRIPT_NAME);
  }

  private lifecycleHookScriptPath(identity: IdentityEndpoints): string {
    return path.join(identity.configDir, LIFECYCLE_HOOK_SCRIPT_NAME);
  }

  private codexHomePath(identity: IdentityEndpoints): string {
    return path.join(identity.configDir, CODEX_HOME_DIR);
  }

  private async readRolloutInputEvidence(session: string): Promise<RolloutInputEvidence> {
    if (this.sessionDataDir === undefined) return { idle: false, lastUserMessage: null };
    const root = path.join(this.sessionDataDir, session, CODEX_HOME_DIR, 'sessions');
    let entries: string[];
    try {
      entries = await readdir(root, { recursive: true });
    } catch {
      return { idle: false, lastUserMessage: null };
    }
    const relative = entries.filter((entry) => path.basename(entry).startsWith('rollout-') && entry.endsWith('.jsonl'));
    relative.sort();
    const newest = relative[relative.length - 1];
    if (newest === undefined) return { idle: false, lastUserMessage: null };
    const rolloutPath = path.join(root, newest);

    let metadata: { size: number; mtimeMs: number };
    try {
      const result = await stat(rolloutPath);
      metadata = { size: result.size, mtimeMs: result.mtimeMs };
    } catch {
      return { idle: false, lastUserMessage: null };
    }
    const cached = this.rolloutInputCache.get(session);
    if (cached?.path === rolloutPath && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
      return cached;
    }

    let raw: string;
    try {
      raw = await readFile(rolloutPath, 'utf8');
    } catch {
      return { idle: false, lastUserMessage: null };
    }
    let idle = false;
    let lastUserMessage: string | null = null;
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      let parsedLine: unknown;
      try {
        parsedLine = JSON.parse(line);
      } catch {
        continue;
      }
      const userMessage = userTextFromRolloutLine(parsedLine);
      if (userMessage !== null) lastUserMessage = userMessage;
      const record = asRecord(parsedLine);
      const payload = record === null ? null : (asRecord(record.payload) ?? record);
      if (payload?.type === 'task_started') idle = false;
      else if (payload?.type === 'task_complete' || payload?.type === 'turn_aborted') idle = true;
    }
    const evidence: CachedRolloutInputEvidence = { path: rolloutPath, ...metadata, idle, lastUserMessage };
    this.rolloutInputCache.set(session, evidence);
    return evidence;
  }

  /**
   * Create the per-session CODEX_HOME and symlink the shared home's auth/config
   * into it, so the session authenticates and inherits provider config while
   * keeping its own isolated `sessions/`. Symlink failures are non-fatal: a
   * missing shared auth.json just means the session relies on env-var auth.
   */
  private sharedCodexHome(): string {
    return process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  }

  private async prepareCodexHome(
    identity: IdentityEndpoints,
    repo: string,
    sharedHome: string,
    minimumDocBytes: number,
  ): Promise<void> {
    const home = this.codexHomePath(identity);
    await mkdir(home, { recursive: true });

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
    const protectedConfig = ensureProjectDocMaxBytes(sharedConfig, minimumDocBytes);
    const trustHeader = `[projects.${tomlString(repo)}]`;
    const trustEntry = protectedConfig.includes(trustHeader)
      ? ''
      : `\n# ${GENERATED_MARKER}: pre-trust the session working directory\n${trustHeader}\ntrust_level = "trusted"\n`;
    const configDest = path.join(home, 'config.toml');
    // May be a symlink from an earlier conductor version — remove, never write through it.
    await rm(configDest, { force: true });
    await writeFile(configDest, `${protectedConfig}${trustEntry}`);
  }

  private async readActiveGlobalGuidance(sharedHome: string): Promise<string | null> {
    for (const filename of [AGENTS_OVERRIDE_NAME, AGENTS_NAME]) {
      const content = await this.readIfExists(path.join(sharedHome, filename));
      if (content !== null && content.trim().length > 0) return content;
    }
    return null;
  }

  private async warnForProjectDocLimit(repo: string, required: number): Promise<void> {
    const localConfigPath = path.join(repo, '.codex', 'config.toml');
    const localConfig = await this.readIfExists(localConfigPath);
    if (localConfig === null) return;
    const localLimit = readProjectDocMaxBytes(localConfig);
    if (localLimit !== null && localLimit < required) {
      log().warn(
        'codex',
        `${localConfigPath} sets project_doc_max_bytes=${localLimit}, below the ${required} bytes required to preserve managed instructions and repository guidance`,
      );
    }
  }

  /** One-release migration from the former repository-root injection model. */
  private async cleanupLegacyRepoOverride(repo: string): Promise<void> {
    const overridePath = path.join(repo, AGENTS_OVERRIDE_NAME);
    const existing = await this.readIfExists(overridePath);
    if (existing?.includes(GENERATED_MARKER) !== true) return;
    const tracked = await this.isTracked(repo, AGENTS_OVERRIDE_NAME);
    if (!tracked && isGeneratedAgentsOverride(existing)) {
      await rm(overridePath, { force: true });
      return;
    }
    const cleaned = removeConductorInstructions(existing);
    if (cleaned !== existing) await writeFile(overridePath, cleaned);
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

  /** Git's index is authoritative: a dirty/uncommitted file is still tracked. */
  private async isTracked(repo: string, filename: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['-C', repo, 'ls-files', '--error-unmatch', '--', filename], {
        timeout: GIT_TIMEOUT_MS,
      });
      return true;
    } catch {
      // A non-repository, missing git binary, and an untracked path are all
      // safely treated as untracked for the legacy cleanup decision.
      return false;
    }
  }

  private async readIfExists(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }
}
