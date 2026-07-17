/** Two modes only: the operator drives, or the sentinel supervises. */
export type Autonomy = 'facilitated' | 'autonomous';

export type Placement = 'pane' | 'tab' | 'window';

export type Activity = 'working' | 'idle' | 'stalled' | 'stopped';

/** A handle to a terminal pane, owned by a specific backend. */
export interface PaneRef {
  backend: string;
  id: string;
}

export interface PauseState {
  previousAutonomy: Autonomy;
  pausedBy: 'manual' | 'auto-focus';
}

/** Persisted + runtime state for one session. */
export interface SessionState {
  autonomy: Autonomy;
  tag?: string;
  pause?: PauseState;
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

/** A stall surfaced to the sentinel. Carries everything needed to judge it. */
export interface StallEvent {
  id: number;
  session: string;
  kind: StallKind;
  reason?: string;
  paneCapture: string;
  lastAssistantMessage?: string;
  createdAt: number;
}

export type StallResolution =
  { action: 'nudge'; text: string } | { action: 'suppress'; note?: string } | { action: 'escalate'; question: string };
