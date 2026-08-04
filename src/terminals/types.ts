import type { PaneRef, Placement } from '../core/types.js';

export interface TerminalCapabilities {
  /** Backend works without a GUI (tmux). */
  headless: boolean;
}

/**
 * One pane observation used for a protected delivery decision. `token` is an
 * opaque backend-owned revision: when supplied, submitIfUnchanged can reject
 * the write if anything (including operator typing) changed after capture.
 */
export interface DeliveryCapture {
  content: string;
  token: string;
}

export interface DeliveryCaptureOptions {
  /** Preserve ANSI styling when the runtime uses it to distinguish a draft from placeholder chrome. */
  styled: boolean;
}

export interface CreatePaneOptions {
  /**
   * Create the pane in the detached fleet session instead of the operator's
   * window — the session runs out of sight (`/summon` brings it in). Only
   * meaningful on backends with `capabilities.headless`.
   */
  headless?: boolean;
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
  createPane(session: string, placement: Placement, cwd?: string, opts?: CreatePaneOptions): Promise<PaneRef>;

  /**
   * Bring a session's pane to the operator. tmux moves the pane into the
   * operator's current window (out of a detached session or another window);
   * iTerm reveals/focuses the pane's window. Returns a human-readable outcome.
   */
  summon?(pane: PaneRef, session: string): Promise<string>;

  /**
   * The inverse of summon: move the pane out of the operator's view into the
   * detached fleet session, where it keeps running headless (tmux only —
   * iTerm panes cannot run detached).
   */
  banish?(pane: PaneRef, session: string): Promise<string>;

  /**
   * Run a session launch command in an idle pane. Implementations must handle
   * the shell-init race in fresh panes by waiting for a prompt before typing;
   * the same method is also used to restart in a discovered existing pane.
   */
  launch(pane: PaneRef, command: string): Promise<void>;

  /** Deliver subsequent input. Must be safe for multiline/long text (bracketed paste). */
  run(pane: PaneRef, text: string): Promise<void>;

  /**
   * Optional compare-and-submit path for autonomous delivery. The capture and
   * token must describe the same pane observation. submitIfUnchanged returns
   * false without writing when the pane changed after that observation.
   */
  captureForDelivery?(pane: PaneRef, lines: number, options?: DeliveryCaptureOptions): Promise<DeliveryCapture>;
  submitIfUnchanged?(pane: PaneRef, text: string, token: string): Promise<boolean>;

  /** Trailing `lines` of pane content. */
  capture(pane: PaneRef, lines: number): Promise<string>;

  /**
   * Like capture(), but retaining the ANSI style escape sequences (SGR).
   * Styling carries information plain text loses — e.g. Codex renders its
   * composer ghost hint dim, which is the only reliable way to tell it from
   * operator-typed text. Only backends whose capture path preserves styling
   * implement this (tmux `capture-pane -e`; iTerm's AppleScript cannot).
   */
  captureStyled?(pane: PaneRef, lines: number): Promise<string>;

  /**
   * Whether the pane still exists.
   *
   * Return false ONLY for an observation that completed and found the pane
   * absent. THROW when the terminal could not be observed at all — a timeout,
   * a dead server, a scripting error. The two are not interchangeable: false
   * makes lifecycle mark the session stopped and forget its pane mapping, and
   * because reconcile only visits mapped panes, no later tick revisits the
   * seat. Reporting an unobservable terminal as an absent pane therefore
   * retires a live session permanently, on nothing more than a transient.
   *
   * Callers are built for the throw: lifecycle records an unknown observation,
   * health warns and skips the tick, delivery holds the queue.
   */
  isAlive(pane: PaneRef): Promise<boolean>;

  /**
   * Whether the pane's interactive shell currently has a foreground job.
   * Unlike isAlive(), this becomes false when an operator interrupts Claude or
   * Codex with Ctrl-C and the pane returns to its shell prompt.
   */
  isSessionActive(pane: PaneRef): Promise<boolean>;

  kill(pane: PaneRef): Promise<void>;

  /** Rename the pane's visible label; inlineName omits metadata such as tags. */
  rename(pane: PaneRef, name: string, inlineName?: string): Promise<void>;

  /**
   * Optional shell snippet prepended to the runtime launch command so the pane
   * titles itself from inside the command line (immune to the shell's own
   * title escape — last writer wins).
   */
  titleShellPrefix?(displayName: string, inlineName?: string): string;

  /** Map of session codename -> surviving pane, discovered after a conductor restart. */
  rediscover(): Promise<Map<string, PaneRef>>;
}
