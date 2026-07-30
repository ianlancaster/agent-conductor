import type { PaneActivityEvidence, RuntimeEvent } from '../core/types.js';
import type { SessionConfig } from '../config/schema.js';

export interface RuntimeCapabilities {
  /** Runtime can push lifecycle events (hooks / notify). */
  lifecycleEvents: boolean;
  /** Runtime provides a positive, authoritative end-of-turn event. */
  authoritativeTurnCompletion?: boolean;
  /** Runtime supports an interactive context probe (e.g. Claude's /context). */
  contextProbe: boolean;
  /**
   * parseInputState understands ANSI-styled captures and prefers them (e.g.
   * Codex marks ghost hints dim — deterministic where plain text must guess).
   * When true and the backend implements captureStyled, delivery feeds the
   * styled capture instead of the plain one.
   */
  styledCapture: boolean;
}

/** Per-session endpoints the runtime wires its identity into. */
export interface IdentityEndpoints {
  /** MCP URL carrying the session's codename — the mechanical identity. */
  mcpUrl: string;
  /** Events URL lifecycle hooks POST to. */
  eventsUrl: string;
  /** Directory where per-session generated config files live. */
  configDir: string;
}

export interface LaunchOptions {
  prompt?: string;
  continueSession?: boolean;
  /** Runtime-specific reasoning effort resolved for this process launch. */
  effort?: string;
  /** Runtime-neutral approval/sandbox bypass resolved from session + fleet config. */
  bypassPermissions?: boolean;
}

/** Runtime-owned launch artifacts proved while writing generated configuration. */
export interface RuntimePreparation {
  /** SHA-256 of the exact generated PreToolUse block, when one was written. */
  hooksRenderedDigest?: string;
}

/**
 * What the runtime's visible input line holds.
 * - `'clear'` — the composer is visibly and unambiguously empty: safe to type.
 * - `'draft'` — the composer contains any text. Its source, signature, age,
 *   and length are deliberately irrelevant; delivery must queue indefinitely.
 * - `null` — cannot be determined from this capture. Delivery must queue.
 */
export type InputState = 'clear' | 'draft' | null;

/**
 * The seam between the conductor and a specific agent CLI (Claude Code, Codex).
 *
 * Owns everything runtime-specific: launch command construction, identity/hook
 * config generation, prompt-glyph parsing, terminal-chrome stripping, transcript
 * reading, and lifecycle-event payload parsing.
 */
export interface SessionRuntime {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;

  /**
   * Write per-session config files (MCP identity, lifecycle hooks, instruction
   * injection) before launch. Idempotent.
   */
  prepare(session: SessionConfig, identity: IdentityEndpoints): Promise<RuntimePreparation | void>;

  /** Full shell command line to start (or continue) the session in its pane. */
  buildLaunchCommand(session: SessionConfig, identity: IdentityEndpoints, opts: LaunchOptions): string;

  /**
   * The model this launch will actually pin, using the same precedence the
   * runtime applies when it builds the command. Undefined means no pin is
   * passed and the agent CLI chooses — which must be reported as unknown, never
   * as a value.
   *
   * Resolution lives here rather than in core because each runtime owns its own
   * precedence, and a second copy in core would silently drift from the flags
   * actually passed. Conductor persists the answer so that a config edited after
   * launch, or a pane adopted across a restart, cannot make a stale process look
   * like it matches its declaration.
   */
  resolveLaunchModel(session: SessionConfig, opts: LaunchOptions): string | undefined;

  /**
   * Classify the runtime's input line from a pane capture. `session` (the
   * codename) lets runtimes keep per-session state (e.g. Codex learns each
   * session's composer ghost text).
   */
  parseInputState(capture: string, session?: string): InputState;
  /**
   * True when the frame is holding an interactive prompt that a human must
   * answer — a permission request, a plan confirmation, or an agent-authored
   * question. Delivery treats this as an unconditional veto rather than one
   * parser's opinion: such prompts render a free-text option that looks exactly
   * like an empty composer, and submitting into one answers a question nobody
   * asked Conductor to answer.
   */
  hasBlockingPrompt?(capture: string, session?: string): boolean;

  /**
   * Classify whether the runtime is executing a turn. This must use positive
   * runtime execution/idle evidence and must not equate a visible composer
   * with idleness when the runtime can accept queued or steering input.
   */
  parseActivityState?(capture: string, session?: string): PaneActivityEvidence;

  /**
   * Resolve a visually ambiguous input state with runtime-owned external
   * evidence. Used by Codex on plain iTerm captures, where ANSI styling is
   * unavailable but the rollout can prove a visible row was already submitted.
   */
  resolveInputState?(capture: string, session: string, parsed: InputState): Promise<InputState>;

  /** Strip runtime-specific terminal chrome from a pane capture. */
  stripChrome(capture: string): string;

  /** Parse a lifecycle-event HTTP payload into a normalized event. Null = not recognized. */
  parseEvent(body: unknown): Omit<RuntimeEvent, 'session' | 'receivedAt'> | null;

  /** Last assistant message from a session transcript, when the runtime exposes one. */
  readLastAssistantMessage?(transcriptPath: string): Promise<string | null>;
}
