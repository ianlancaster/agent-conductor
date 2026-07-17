import type { PaneRef, Placement } from '../core/types.js';

export interface TerminalCapabilities {
  /** Backend can report which session's pane has OS keyboard focus (iTerm2 only). */
  focusTracking: boolean;
  /** Backend works without a GUI (tmux). */
  headless: boolean;
}

/**
 * The seam between the conductor and a terminal multiplexer/emulator.
 *
 * Implementations own pane lifecycle, text delivery, and content capture.
 * They know nothing about session runtimes — runtime-specific parsing (input-clear
 * glyphs, terminal chrome) lives on SessionRuntime.
 */
export interface TerminalBackend {
  readonly name: string;
  readonly capabilities: TerminalCapabilities;

  /** Create or rediscover the workspace (window / tmux session). */
  init(): Promise<void>;

  /** Create a pane for a session. `cwd` is the directory the shell should start in. */
  createPane(session: string, placement: Placement, cwd?: string): Promise<PaneRef>;

  /**
   * Run the FIRST command in a fresh pane. Implementations must handle the
   * shell-init race (wait for a prompt before typing).
   */
  launch(pane: PaneRef, command: string): Promise<void>;

  /** Deliver subsequent input. Must be safe for multiline/long text (bracketed paste). */
  run(pane: PaneRef, text: string): Promise<void>;

  /** Trailing `lines` of pane content. */
  capture(pane: PaneRef, lines: number): Promise<string>;

  isAlive(pane: PaneRef): Promise<boolean>;

  kill(pane: PaneRef): Promise<void>;

  /** Rename the pane's visible label. Conductor passes `codename` or `codename — tag`. */
  rename(pane: PaneRef, name: string): Promise<void>;

  /**
   * Optional shell snippet prepended to the runtime launch command so the pane
   * titles itself from inside the command line (immune to the shell's own
   * title escape — last writer wins).
   */
  titleShellPrefix?(displayName: string): string;

  /** Map of session codename -> surviving pane, discovered after a conductor restart. */
  rediscover(): Promise<Map<string, PaneRef>>;

  /** Which session's pane has keyboard focus, if focusTracking is supported. */
  getFocusedSession?(): Promise<string | null>;

  /** Bring the workspace to the foreground, if the backend has a GUI. */
  focusWindow?(): Promise<void>;
}
