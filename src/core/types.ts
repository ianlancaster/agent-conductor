import type { RuntimeName } from '../config/schema.js';

export type Placement = 'pane' | 'tab' | 'window';

export type Activity = 'working' | 'idle' | 'stalled' | 'stopped';

/** A handle to a terminal pane, owned by a specific backend. */
export interface PaneRef {
  backend: string;
  id: string;
}

/** Persisted + runtime state for one session. */
export interface SessionState {
  auto: boolean;
  tag?: string;
  paused: boolean;
  /** Runtime for the active run. Absent while stopped; the session config remains the default. */
  runtime?: RuntimeName;
  running: boolean;
  /**
   * The runtime process has proven it is up (first lifecycle event received).
   * Deliveries are queued until then — typing into a pane whose launch command
   * is still executing splices text into the shell line and corrupts it.
   */
  ready: boolean;
  paneId?: string;
  activity: Activity;
  /** Marker file present in the repo — displayed as an agent project (🤖) rather than a plain session. */
  isAgentProject: boolean;
}

export type RuntimeEventType = 'stop' | 'notification' | 'compaction' | 'session-start' | 'session-end';

/** A lifecycle event pushed by a session's runtime hooks (Claude hooks / Codex notify). */
export interface RuntimeEvent {
  session: string;
  type: RuntimeEventType;
  reason?: string;
  transcriptPath?: string;
  receivedAt: number;
}

export type StallKind = 'idle' | 'blocked' | 'compaction' | 'silent' | 'session-end';
