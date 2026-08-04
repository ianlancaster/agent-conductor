import type { RuntimeName } from '../config/schema.js';

export type Placement = 'pane' | 'tab' | 'window';

/** Mechanical session activity. Stall causes remain events, not durable activity states. */
export type Activity = 'working' | 'idle' | 'stopped';

/** Runtime-owned evidence about whether a live runtime is executing a turn. */
export type PaneActivityEvidence = 'working' | 'idle' | 'unknown';

/** A handle to a terminal pane, owned by a specific backend. */
export interface PaneRef {
  backend: string;
  id: string;
}

/**
 * What became of one operator-bound message.
 *
 * - `delivered` — a live operator surface accepted it.
 * - `queued` — no surface was attached, so it is held durably and flushed on attach.
 * - `lost` — it could be neither delivered nor held.
 *
 * `delivered` and `queued` are deliberately not distinguished in what a session
 * is told: the distinction is operator-presence information, and a session that
 * can read it can probe whether anyone is watching.
 */
export type OperatorSendOutcome = 'delivered' | 'queued' | 'lost';

/** Persisted + runtime state for one session. */
export interface SessionState {
  auto: boolean;
  tag?: string;
  paused: boolean;
  /** Runtime for the active run. Absent while stopped; the session config remains the default. */
  runtime?: RuntimeName;
  /** Reasoning effort resolved for the active process. Absent when the runtime chooses. */
  effort?: string;
  /**
   * Model the live process was launched with, as the runtime resolved it.
   * Absent when the runtime was left to choose, and absent for a session whose
   * launch predates this record — both are reported as unknown rather than
   * inferred from the config, which may have been edited since launch.
   */
  model?: string;
  /**
   * When the live process was launched, ISO-8601. Absent while stopped and for a
   * process adopted from before this record existed. It is what turns a model
   * mismatch from a fact into a measurable one: how long the session has been
   * running something its config no longer declares.
   */
  launchedAt?: string;
  running: boolean;
  /**
   * The runtime process has proven it is up through a lifecycle event,
   * foreground-process check, visible runtime chrome, or adopted live pane.
   * Deliveries are queued until then — typing into a pane whose launch command
   * is still executing splices text into the shell line and corrupts it.
   */
  ready: boolean;
  paneId?: string;
  activity: Activity;
  /** Marker file present in the repo — displayed as an agent project (🤖) rather than a plain session. */
  isAgentProject: boolean;
}

export type RuntimeEventType =
  'turn-start' | 'stop' | 'notification' | 'compaction' | 'compaction-complete' | 'session-start' | 'session-end';

/** A lifecycle event pushed by a session's runtime hooks (Claude hooks / Codex notify). */
export interface RuntimeEvent {
  session: string;
  type: RuntimeEventType;
  /** Runtime-owned identity used to reject stale, out-of-order completion events. */
  turnId?: string;
  reason?: string;
  transcriptPath?: string;
  receivedAt: number;
}

export type StallKind = 'idle' | 'blocked' | 'compaction' | 'silent' | 'session-end';
