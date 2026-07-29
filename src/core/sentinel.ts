import { log } from '../logger.js';
import type { SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { StallInfo } from './health.js';
import { contentSimilarity, fleetDownEnvelope, fleetStallEnvelope, stallEnvelope, truncate } from './utils.js';
import type { Activity, PaneRef, StallKind } from './types.js';
import type { ConductorEventPublisher } from '../events/types.js';
import type { RecentMessageActivity } from '../store/index.js';

const SENTINEL_DOWN_WARN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Smallest fleet that can produce a fleet-level fact. With one running standing
 * member, "no member is working" is a restatement of that member's own idle
 * stall, which the sentinel already receives — so the campaign-level instrument
 * would only duplicate it. This is a property of what the signal means, not a
 * noise threshold, and it is deliberately not configurable.
 */
const FLEET_WATCH_QUORUM = 2;

/** What fleet watch can actually do right now, as opposed to whether it is switched on. */
export interface FleetWatchStatus {
  enabled: boolean;
  /**
   * - `off` — switched off.
   * - `armed` — enabled and structurally able to fire.
   * - `inert` — enabled but there is no standing roster to measure.
   * - `suppressed` — enabled, with a roster, but currently unable to fire.
   */
  state: 'off' | 'armed' | 'inert' | 'suppressed';
  /** Why it cannot fire; undefined only when armed or off. */
  reason?: string;
  /** Standing (non-sentinel, non-ephemeral) members it measures. */
  members: readonly string[];
  /** Standing members that are currently up. */
  runningMembers: readonly string[];
  /** Signals this instrument can currently produce. Empty means it cannot fire at all. */
  covers: readonly ('fleet-stall' | 'fleet-down')[];
}

function normalizeTimestamp(timestamp: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(timestamp) ? `${timestamp.replace(' ', 'T')}.000Z` : timestamp;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

export interface SentinelDeps {
  config: {
    captureLines: number;
    suppressWindowMs: number;
    suppressSimilarity: number;
    sentinelCodename: string | undefined;
    fleetStallThresholdSeconds: number;
  };
  backend: TerminalBackend;
  runtimeFor(session: string): SessionRuntime | undefined;
  getPane(session: string): PaneRef | undefined;
  isAuto(session: string): boolean;
  isPaused(session: string): boolean;
  /** Canonical activity for every registered session; stopped sessions remain fleet members. */
  activityFor(session: string): Activity | undefined;
  /** True for short-lived workers, which are not part of the standing fleet. */
  isEphemeral(session: string): boolean;
  isActive(session: string): boolean | Promise<boolean>;
  deliver(session: string, text: string): Promise<unknown>;
  notifyOperator(text: string): Promise<unknown>;
  logEvent(session: string, event: string, detail?: string): void;
  recentMessages?(session: string, limit: number): readonly RecentMessageActivity[];
  initialFleetWatchEnabled?: boolean;
  initialSessions?: Iterable<string>;
  onFleetWatchChanged?(enabled: boolean): void;
  events?: ConductorEventPublisher;
}

/**
 * Routes stalls of auto sessions to the designated sentinel session as
 * ONE self-contained message per stall — the sentinel acts with ordinary
 * primitives (tail_session to look, send_to_session to nudge,
 * send_to_operator to ask; doing nothing dismisses). There is no queue and no
 * sentinel-only tool surface. The conductor's only judgments are mechanical:
 * auto gating, dedup suppression, and undeliverable-stall alerts. Session
 * activity state (working/idle/stopped) is the health monitor's bookkeeping —
 * fully decoupled from anything the sentinel does.
 */
export class StallSentinelRouter {
  private readonly lastRouted = new Map<string, { capture: string; kind: StallKind; at: number }>();
  private lastSentinelDownWarnAt = 0;
  private sentinelDown = false;
  private sentinel: string | undefined;
  private registeredSessions: Set<string>;
  private fleetWatchEnabled: boolean;
  private fleetWatchActive = false;
  private fleetAllNonWorkingAt: number | undefined;
  private fleetNotified = false;
  private fleetTimer: NodeJS.Timeout | undefined;
  private fleetDownNotified = false;
  private fleetDownTimer: NodeJS.Timeout | undefined;
  /** A fleet that has never been up has not gone down; booting is not an outage. */
  private standingMemberSeenRunning = false;

  constructor(private readonly deps: SentinelDeps) {
    this.sentinel = deps.config.sentinelCodename;
    this.registeredSessions = new Set(deps.initialSessions ?? []);
    this.fleetWatchEnabled = deps.initialFleetWatchEnabled ?? false;
  }

  /** Begin evaluation only after startup pane rediscovery reconciles the roster. */
  activateFleetWatch(): void {
    if (this.fleetWatchActive) return;
    this.fleetWatchActive = true;
    this.resetFleetConfirmation();
    this.evaluateFleetWatch();
  }

  sentinelCodename(): string | undefined {
    return this.sentinel;
  }

  setSentinel(codename: string | undefined): void {
    this.sentinel = codename;
    this.lastSentinelDownWarnAt = 0;
    this.sentinelDown = false;
    this.resetFleetConfirmation();
    this.evaluateFleetWatch();
  }

  /** A new run must not inherit duplicate suppression from the previous run. */
  reset(session: string): void {
    this.resetRouting(session);
    this.resetFleetConfirmation();
    this.evaluateFleetWatch();
  }

  /** Mode changes affect individual routing only; fleet-watch timing is independent. */
  resetRouting(session: string): void {
    this.lastRouted.delete(session);
    if (this.isSentinel(session)) this.lastSentinelDownWarnAt = 0;
  }

  isSentinel(caller: string): boolean {
    return this.sentinel !== undefined && caller === this.sentinel;
  }

  toggleFleetWatch(): boolean {
    this.fleetWatchEnabled = !this.fleetWatchEnabled;
    this.resetFleetConfirmation();
    this.evaluateFleetWatch();
    this.deps.onFleetWatchChanged?.(this.fleetWatchEnabled);
    return this.fleetWatchEnabled;
  }

  isFleetWatchEnabled(): boolean {
    return this.fleetWatchEnabled;
  }

  setRegisteredSessions(sessions: Iterable<string>): void {
    const next = new Set(sessions);
    // An unchanged roster still re-evaluates: a config edit can move a session
    // between the standing fleet and the pod population without adding or
    // removing anyone. Only a genuine roster change restarts the confirmation
    // window, or a reload every heartbeat would keep resetting it.
    if (!setsEqual(this.registeredSessions, next)) {
      this.registeredSessions = next;
      this.resetFleetConfirmation();
    }
    this.evaluateFleetWatch();
  }

  /** Any successfully submitted work clears fleet-stall state and rearms affected watches. */
  noteWorking(session: string): void {
    if (!this.fleetMembers().includes(session)) return;
    const outageTracked = this.fleetDownNotified || this.fleetDownTimer !== undefined;
    if (this.fleetAllNonWorkingAt === undefined && !this.fleetNotified && !outageTracked) return;
    this.resetFleetConfirmation();
    this.evaluateFleetWatch();
  }

  /**
   * Standing liveness check for the one seat whose failure disables all stall
   * routing. Fleet watch excludes the sentinel by design, and an undeliverable
   * stall only reveals a dead sentinel at the moment something already needed
   * it — the worst possible time to find out. This runs on the ordinary
   * heartbeat, costs no agent context, and is deliberately mechanical: it
   * reports process liveness, never judgment about the sentinel's behavior.
   */
  async checkSentinelHealth(): Promise<void> {
    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      this.sentinelDown = false;
      return;
    }
    let active: boolean;
    try {
      active = await this.deps.isActive(sentinel);
    } catch {
      // Inconclusive inspection is not evidence of failure.
      return;
    }
    if (active) {
      if (!this.sentinelDown) return;
      this.sentinelDown = false;
      this.lastSentinelDownWarnAt = 0;
      this.deps.logEvent(sentinel, 'sentinel_up', 'stall routing has a destination again');
      await this.deps.notifyOperator(`✅ Sentinel ${sentinel} is running again — stall routing is restored.`);
      return;
    }
    this.sentinelDown = true;
    const now = Date.now();
    // Shares the undeliverable-stall rate limit: both report the same fact.
    if (now - this.lastSentinelDownWarnAt <= SENTINEL_DOWN_WARN_INTERVAL_MS) return;
    this.lastSentinelDownWarnAt = now;
    this.deps.logEvent(sentinel, 'sentinel_down', 'no stall can be routed');
    await this.deps.notifyOperator(
      `⚠️ Sentinel ${sentinel} is not running — no session's stalls can be routed until it is back.`,
    );
  }

  async handleStall(session: string, kind: StallKind, info: StallInfo): Promise<void> {
    const detectedAt = info.detectedAt ?? new Date().toISOString();
    this.deps.logEvent(session, `stall_${kind}`, info.reason);

    // The sentinel spends its life idle between stalls — that is its normal
    // state, not an emergency. Its own stalls are logged and otherwise
    // ignored; the meaningful "watcher is down" signal is a stall that cannot
    // be DELIVERED because the sentinel is not running (below).
    if (this.isSentinel(session)) {
      log().debug('sentinel', `${session}: ${kind} stall ignored (the sentinel idles by design)`);
      return;
    }

    // session-end is handled as a lifecycle stop before it reaches this
    // router. Keep this guard mechanical if a custom health source violates
    // that contract; it is not part of the public stall vocabulary.
    if (kind === 'session-end') return;

    // The supervisor publishes the non-working activity before routing this
    // causal evidence, so fleet watch evaluates the canonical current state.
    this.evaluateFleetWatch();

    // Pause is the temporary override and therefore wins when auto is also off.
    // A dropped stall is recorded beside the routed ones. A seat whose stalls
    // are being discarded otherwise looks identical to a supervised one: the
    // detection worked, the evidence existed, and nothing said it went nowhere.
    if (this.deps.isPaused(session)) {
      this.deps.logEvent(session, 'stall_dropped', `${kind} not routed: session is paused`);
      this.deps.events?.emit({ type: 'stall', session, kind, detectedAt, disposition: 'ignored-paused' });
      log().debug('sentinel', `${session}: ${kind} stall ignored (session is paused)`);
      return;
    }
    if (!this.deps.isAuto(session)) {
      this.deps.logEvent(session, 'stall_dropped', `${kind} not routed: auto is off`);
      this.deps.events?.emit({ type: 'stall', session, kind, detectedAt, disposition: 'ignored-auto-off' });
      log().debug('sentinel', `${session}: ${kind} stall ignored (auto is off)`);
      return;
    }

    const capture = await this.captureStripped(session);

    const last = this.lastRouted.get(session);
    if (
      last?.kind === kind &&
      Date.now() - last.at < this.deps.config.suppressWindowMs &&
      contentSimilarity(capture, last.capture) > this.deps.config.suppressSimilarity
    ) {
      this.deps.logEvent(session, 'stall_suppressed', `similar ${kind} stall within window`);
      this.deps.events?.emit({ type: 'stall', session, kind, detectedAt, disposition: 'suppressed' });
      return;
    }

    this.lastRouted.set(session, { capture, kind, at: Date.now() });

    // No sentinel is a perfectly fine setup: the stall goes straight to the
    // operator as a plain report — no queue (nothing would drain it), no
    // suggestion to configure one.
    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      const summary = info.reason !== undefined ? `: ${truncate(info.reason, 120)}` : '';
      const communications = this.recentCommunications(session);
      this.deps.logEvent(session, 'stall_reported', `${kind} → operator`);
      await this.deps.notifyOperator(
        `⚠️ ${session} stalled (${kind}) at ${detectedAt}${summary}${communications.length > 0 ? `\nRecent conductor messages:\n${communications.join('\n')}` : ''}`,
      );
      this.deps.events?.emit({ type: 'stall', session, kind, detectedAt, disposition: 'reported-to-operator' });
      return;
    }

    // Sentinel not running: the stall cannot be delivered — this is the one
    // genuinely alarming state, reported to the operator (rate-limited).
    if (!(await this.deps.isActive(sentinel))) {
      const now = Date.now();
      if (now - this.lastSentinelDownWarnAt > SENTINEL_DOWN_WARN_INTERVAL_MS) {
        this.lastSentinelDownWarnAt = now;
        await this.deps.notifyOperator(
          `⚠️ ${session} stalled (${kind}) at ${detectedAt} but sentinel ${sentinel} is not running.`,
        );
      }
      this.deps.events?.emit({ type: 'stall', session, kind, detectedAt, disposition: 'sentinel-down' });
      return;
    }

    // One self-contained message: session, kind, and the (truncated) last
    // assistant message it stalled on. Everything else the sentinel needs it
    // gets with primitives (tail_session for the pane, send_to_session to
    // nudge, send_to_operator to ask; doing nothing dismisses).
    const lastMessage =
      (await this.readTranscript(session, info.transcriptPath)) ?? info.reason ?? '(no last message available)';
    this.deps.logEvent(session, 'stall_routed', `${kind} → ${sentinel}`);
    const communications = this.recentCommunications(session);
    await this.deps.deliver(
      sentinel,
      stallEnvelope(
        session,
        kind,
        detectedAt,
        `last: ${truncate(lastMessage, 400)}${communications.length > 0 ? `\nrecent conductor messages:\n${communications.join('\n')}` : ''}`,
      ),
    );
    this.deps.events?.emit({ type: 'stall', session, kind, detectedAt, disposition: 'routed' });
  }

  stop(): void {
    if (this.fleetTimer !== undefined) clearTimeout(this.fleetTimer);
    if (this.fleetDownTimer !== undefined) clearTimeout(this.fleetDownTimer);
    this.fleetDownTimer = undefined;
    this.fleetWatchActive = false;
  }

  /**
   * The standing fleet: registered sessions that are neither the sentinel nor
   * ephemeral pods. Spawned workers join and leave the roster constantly, so
   * measuring them makes the instrument mean something different every few
   * minutes — continuously busy while lanes run, then dark when they finish.
   */
  private fleetMembers(): string[] {
    return [...this.registeredSessions].filter(
      (session) => !this.isSentinel(session) && !this.deps.isEphemeral(session),
    );
  }

  /** Standing members that are up. A stopped seat cannot make progress and is not news. */
  private runningFleetMembers(sessions: readonly string[]): string[] {
    return sessions.filter((session) => this.deps.activityFor(session) !== 'stopped');
  }

  private allFleetMembersNonWorking(sessions: readonly string[]): boolean {
    return sessions.length > 0 && sessions.every((session) => this.deps.activityFor(session) !== 'working');
  }

  /**
   * What fleet watch can do right now. An instrument that reports itself armed
   * while it is structurally incapable of firing is worse than one that is
   * switched off, because its silence reads as an all-clear.
   */
  fleetWatchStatus(): FleetWatchStatus {
    const members = this.fleetMembers();
    const runningMembers = this.runningFleetMembers(members);
    const base = { enabled: this.fleetWatchEnabled, members, runningMembers } as const;
    if (!this.fleetWatchEnabled) return { ...base, state: 'off', covers: [] };
    if (!this.fleetWatchActive) {
      return { ...base, state: 'inert', reason: 'startup roster reconciliation has not finished', covers: [] };
    }
    if (members.length === 0) {
      return {
        ...base,
        state: 'inert',
        reason:
          this.registeredSessions.size === 0
            ? 'no sessions are registered'
            : 'no standing sessions are registered (ephemeral and sentinel seats are not measured)',
        covers: [],
      };
    }
    // Two distinct facts, with distinct preconditions: a quiet fleet needs a
    // quorum to mean anything, while an absent one needs the fleet to have been
    // up at some point in this process.
    const covers: ('fleet-stall' | 'fleet-down')[] = [];
    if (runningMembers.length >= FLEET_WATCH_QUORUM) covers.push('fleet-stall');
    if (runningMembers.length === 0 && this.standingMemberSeenRunning) covers.push('fleet-down');
    if (covers.length > 0) return { ...base, state: 'armed', covers };
    return {
      ...base,
      state: 'suppressed',
      reason:
        runningMembers.length === 0
          ? 'no standing session has run since Conductor started, so an outage would be a fleet that never came up'
          : `quorum unmet — ${String(runningMembers.length)} of ${String(members.length)} standing session(s) running, ${String(FLEET_WATCH_QUORUM)} needed; a single seat's idle stall already carries this`,
      covers,
    };
  }

  private evaluateFleetWatch(): void {
    if (!this.fleetWatchActive || !this.fleetWatchEnabled) return;
    const sessions = this.fleetMembers();
    const running = this.runningFleetMembers(sessions);

    if (running.length > 0) {
      this.standingMemberSeenRunning = true;
      // The fleet is back up: rearm the outage latch for the next one.
      this.fleetDownNotified = false;
      if (this.fleetDownTimer !== undefined) {
        clearTimeout(this.fleetDownTimer);
        this.fleetDownTimer = undefined;
      }
    } else if (sessions.length > 0) {
      // Nothing is running. This is not a quiet fleet, it is an absent one, and
      // no stopped session will ever report it — so it takes its own path
      // rather than being suppressed by the stall quorum.
      this.scheduleFleetDown();
      return;
    }

    if (this.fleetNotified || this.fleetAllNonWorkingAt !== undefined) return;
    if (running.length < FLEET_WATCH_QUORUM) return;
    if (!this.allFleetMembersNonWorking(sessions)) return;

    this.fleetAllNonWorkingAt = Date.now();
    if (this.deps.config.fleetStallThresholdSeconds <= 0) {
      void this.reportFleetStall();
      return;
    }
    this.fleetTimer = setTimeout(() => {
      this.fleetTimer = undefined;
      const currentSessions = this.fleetMembers();
      if (
        this.runningFleetMembers(currentSessions).length < FLEET_WATCH_QUORUM ||
        !this.allFleetMembersNonWorking(currentSessions)
      ) {
        this.fleetAllNonWorkingAt = undefined;
        return;
      }
      void this.reportFleetStall();
    }, this.deps.config.fleetStallThresholdSeconds * 1000);
    this.fleetTimer.unref();
  }

  private resetFleetConfirmation(): void {
    if (this.fleetTimer !== undefined) clearTimeout(this.fleetTimer);
    this.fleetTimer = undefined;
    this.fleetAllNonWorkingAt = undefined;
    this.fleetNotified = false;
    // The outage latch and its timer are deliberately NOT reset here. Stopping
    // the last session is itself a lifecycle reset, and clearing the pending
    // confirmation on every such boundary would postpone the very alert that
    // boundary should produce. Only the fleet coming back up rearms it.
  }

  /**
   * An outage is a transition, so it needs the fleet to have been up first.
   * Starting Conductor with nothing running is a fleet that has not come up
   * yet, not one that has gone dark, and alerting there would train the
   * operator to ignore the signal on exactly the night it matters.
   */
  private scheduleFleetDown(): void {
    if (!this.standingMemberSeenRunning || this.fleetDownNotified || this.fleetDownTimer !== undefined) return;
    if (this.deps.config.fleetStallThresholdSeconds <= 0) {
      void this.reportFleetDown();
      return;
    }
    this.fleetDownTimer = setTimeout(() => {
      this.fleetDownTimer = undefined;
      void this.reportFleetDown();
    }, this.deps.config.fleetStallThresholdSeconds * 1000);
    this.fleetDownTimer.unref();
  }

  private async reportFleetDown(): Promise<void> {
    const sessions = this.fleetMembers();
    if (!this.fleetWatchActive || !this.fleetWatchEnabled || this.fleetDownNotified) return;
    if (sessions.length === 0 || this.runningFleetMembers(sessions).length > 0) return;
    this.fleetDownNotified = true;
    const detectedAt = new Date().toISOString();
    const thresholdSeconds = this.deps.config.fleetStallThresholdSeconds;
    this.deps.logEvent(
      'fleet',
      'fleet_down',
      `no standing session running for ${String(thresholdSeconds)}s: ${sessions.join(', ')}`,
    );

    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      await this.deps.notifyOperator(
        `🚨 Fleet down at ${detectedAt}: no standing session is running (${sessions.join(', ')}).`,
      );
      this.deps.events?.emit({ type: 'fleet.down', sessions, detectedAt, disposition: 'reported-to-operator' });
      return;
    }
    if (!(await this.deps.isActive(sentinel))) {
      await this.deps.notifyOperator(
        `🚨 Fleet down at ${detectedAt}: no standing session is running (${sessions.join(', ')}), and sentinel ${sentinel} is not running either.`,
      );
      this.deps.events?.emit({ type: 'fleet.down', sessions, detectedAt, disposition: 'sentinel-down' });
      return;
    }
    await this.deps.deliver(sentinel, fleetDownEnvelope(sessions, thresholdSeconds, detectedAt));
    this.deps.events?.emit({ type: 'fleet.down', sessions, detectedAt, disposition: 'routed' });
  }

  private async reportFleetStall(): Promise<void> {
    const sessions = this.fleetMembers();
    if (
      !this.fleetWatchActive ||
      this.fleetNotified ||
      this.runningFleetMembers(sessions).length < FLEET_WATCH_QUORUM ||
      !this.allFleetMembersNonWorking(sessions)
    ) {
      return;
    }
    this.fleetNotified = true;
    const detectedAt = new Date().toISOString();
    const thresholdSeconds = this.deps.config.fleetStallThresholdSeconds;
    const detail = `all standing sessions non-working for ${String(thresholdSeconds)}s: ${sessions.join(', ')}`;
    this.deps.logEvent('fleet', 'fleet_stall', detail);

    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      await this.deps.notifyOperator(`🚨 Fleet stalled at ${detectedAt}: ${sessions.join(', ')}.`);
      this.deps.events?.emit({ type: 'fleet.stalled', sessions, detectedAt, disposition: 'reported-to-operator' });
      return;
    }
    if (!(await this.deps.isActive(sentinel))) {
      await this.deps.notifyOperator(
        `🚨 Fleet stalled at ${detectedAt} (${sessions.join(', ')}) but sentinel ${sentinel} is not running.`,
      );
      this.deps.events?.emit({ type: 'fleet.stalled', sessions, detectedAt, disposition: 'sentinel-down' });
      return;
    }
    await this.deps.deliver(sentinel, fleetStallEnvelope(sessions, thresholdSeconds, detectedAt));
    this.deps.events?.emit({ type: 'fleet.stalled', sessions, detectedAt, disposition: 'routed' });
  }

  private async captureStripped(session: string): Promise<string> {
    const pane = this.deps.getPane(session);
    if (pane === undefined) return '';
    try {
      const capture = await this.deps.backend.capture(pane, this.deps.config.captureLines);
      const runtime = this.deps.runtimeFor(session);
      return runtime !== undefined ? runtime.stripChrome(capture) : capture;
    } catch {
      return '';
    }
  }

  private async readTranscript(session: string, transcriptPath: string | undefined): Promise<string | undefined> {
    if (transcriptPath === undefined) return undefined;
    const runtime = this.deps.runtimeFor(session);
    if (runtime?.readLastAssistantMessage === undefined) return undefined;
    try {
      return (await runtime.readLastAssistantMessage(transcriptPath)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private recentCommunications(session: string): string[] {
    return (this.deps.recentMessages?.(session, 3) ?? []).map((message) => {
      const direction =
        message.sender === session ? `outbound to ${message.recipient}` : `inbound from ${message.sender}`;
      const timestamp = message.delivered_at ?? message.cancelled_at ?? message.created_at;
      return `- #${String(message.id)} ${direction} ${message.status} at ${normalizeTimestamp(timestamp)}`;
    });
  }
}
