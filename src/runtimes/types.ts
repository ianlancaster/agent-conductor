import type { RuntimeEvent } from '../core/types.js';
import type { SessionConfig } from '../config/schema.js';

export interface RuntimeCapabilities {
  /** Runtime can push lifecycle events (hooks / notify). */
  lifecycleEvents: boolean;
  /** Runtime supports an interactive context probe (e.g. Claude's /context). */
  contextProbe: boolean;
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
}

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
   * Whether the session's input line is empty (safe to deliver a message).
   * Returns null when it cannot be determined from the capture.
   */
  parseInputClear(capture: string): boolean | null;

  /** Strip runtime-specific terminal chrome from a pane capture. */
  stripChrome(capture: string): string;

  /** Parse a lifecycle-event HTTP payload into a normalized event. Null = not recognized. */
  parseEvent(body: unknown): Omit<RuntimeEvent, 'session' | 'receivedAt'> | null;

  /** Last assistant message from a session transcript, when the runtime exposes one. */
  readLastAssistantMessage?(transcriptPath: string): Promise<string | null>;
}
