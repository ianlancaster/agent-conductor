import type { RuntimeEvent } from '../core/types.js';
import type { SessionConfig } from '../config/schema.js';

export interface RuntimeCapabilities {
  /** Runtime can push lifecycle events (hooks / notify). */
  lifecycleEvents: boolean;
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
  prepare(session: SessionConfig, identity: IdentityEndpoints): Promise<void>;

  /** Full shell command line to start (or continue) the session in its pane. */
  buildLaunchCommand(session: SessionConfig, identity: IdentityEndpoints, opts: LaunchOptions): string;

  /**
   * Classify the runtime's input line from a pane capture. `session` (the
   * codename) lets runtimes keep per-session state (e.g. Codex learns each
   * session's composer ghost text).
   */
  parseInputState(capture: string, session?: string): InputState;

  /** Strip runtime-specific terminal chrome from a pane capture. */
  stripChrome(capture: string): string;

  /** Parse a lifecycle-event HTTP payload into a normalized event. Null = not recognized. */
  parseEvent(body: unknown): Omit<RuntimeEvent, 'session' | 'receivedAt'> | null;

  /** Last assistant message from a session transcript, when the runtime exposes one. */
  readLastAssistantMessage?(transcriptPath: string): Promise<string | null>;
}
