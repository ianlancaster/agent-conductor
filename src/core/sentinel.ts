import { log } from '../logger.js';
import type { SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { StallInfo } from './health.js';
import { contentSimilarity, fleetStallEnvelope, stallEnvelope, truncate } from './utils.js';
import type { PaneRef, StallKind } from './types.js';

const SENTINEL_DOWN_WARN_INTERVAL_MS = 10 * 60 * 1000;

export interface SentinelDeps {
  config: {
    captureLines: number;
    suppressWindowMs: number;
    suppressSimilarity: number;
    sentinelCodename: string | undefined;
  };
  backend: TerminalBackend;
  runtimeFor(session: string): SessionRuntime | undefined;
  getPane(session: string): PaneRef | undefined;
  isAuto(session: string): boolean;
  isPaused(session: string): boolean;
  isActive(session: string): boolean | Promise<boolean>;
  deliver(session: string, text: string): Promise<unknown>;
  notifyOperator(text: string): Promise<unknown>;
  logEvent(session: string, event: string, detail?: string): void;
}

export interface FleetWatch {
  name: string;
  sessions: string[];
  thresholdSeconds: number;
}

export interface FleetWatchStatus extends FleetWatch {
  state: 'watching' | 'confirming' | 'reported';
  stalledSessions: string[];
  allStalledForSeconds: number;
}

export interface FleetWatchMembershipChange {
  name: string;
  removedSessions: string[];
  remainingSessions: string[];
  action: 'continued' | 'invalidated';
}

interface FleetWatchState extends FleetWatch {
  allStalledAt: number | undefined;
  notified: boolean;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Routes stalls of auto sessions to the designated sentinel session as
 * ONE self-contained message per stall — the sentinel acts with ordinary
 * primitives (tail_session to look, send_to_session to nudge,
 * send_to_operator to ask; doing nothing dismisses). There is no queue and no
 * sentinel-only tool surface. The conductor's only judgments are mechanical:
 * auto gating, dedup suppression, and undeliverable-stall alerts. Session
 * activity state (working/stalled/…) is the health monitor's bookkeeping —
 * fully decoupled from anything the sentinel does.
 */
export class StallSentinelRouter {
  private readonly lastRouted = new Map<string, { capture: string; at: number }>();
  private lastSentinelDownWarnAt = 0;
  private sentinel: string | undefined;
  private readonly stalledSessions = new Set<string>();
  private readonly fleetWatches = new Map<string, FleetWatchState>();

  constructor(private readonly deps: SentinelDeps) {
    this.sentinel = deps.config.sentinelCodename;
  }

  sentinelCodename(): string | undefined {
    return this.sentinel;
  }

  setSentinel(codename: string | undefined): void {
    if (codename !== undefined && this.isFleetWatched(codename)) {
      throw new Error(`${codename} is part of an armed fleet watch and cannot also be its stall sentinel.`);
    }
    this.sentinel = codename;
    this.lastSentinelDownWarnAt = 0;
  }

  /** A new run must not inherit duplicate suppression from the previous run. */
  reset(session: string): void {
    this.lastRouted.delete(session);
    this.noteWorking(session);
    if (this.isSentinel(session)) this.lastSentinelDownWarnAt = 0;
  }

  isSentinel(caller: string): boolean {
    return this.sentinel !== undefined && caller === this.sentinel;
  }

  armFleetWatch(watch: FleetWatch): void {
    const sessions = [...new Set(watch.sessions)];
    if (sessions.length < 2) throw new Error('A fleet watch needs at least two distinct sessions.');
    if (sessions.some((session) => this.isSentinel(session))) {
      throw new Error('The stall sentinel cannot be included in a fleet watch.');
    }
    this.disarmFleetWatch(watch.name);
    const state: FleetWatchState = {
      name: watch.name,
      sessions,
      thresholdSeconds: watch.thresholdSeconds,
      allStalledAt: undefined,
      notified: false,
      timer: undefined,
    };
    this.fleetWatches.set(watch.name, state);
    this.evaluateFleetWatch(state);
  }

  disarmFleetWatch(name: string): boolean {
    const watch = this.fleetWatches.get(name);
    if (watch === undefined) return false;
    if (watch.timer !== undefined) clearTimeout(watch.timer);
    return this.fleetWatches.delete(name);
  }

  listFleetWatches(): FleetWatchStatus[] {
    const now = Date.now();
    return [...this.fleetWatches.values()].map((watch) => ({
      name: watch.name,
      sessions: [...watch.sessions],
      thresholdSeconds: watch.thresholdSeconds,
      state: watch.notified ? 'reported' : watch.allStalledAt !== undefined ? 'confirming' : 'watching',
      stalledSessions: watch.sessions.filter((session) => this.stalledSessions.has(session)),
      allStalledForSeconds:
        watch.allStalledAt === undefined ? 0 : Math.max(0, Math.floor((now - watch.allStalledAt) / 1000)),
    }));
  }

  isFleetWatched(session: string): boolean {
    return [...this.fleetWatches.values()].some((watch) => watch.sessions.includes(session));
  }

  /**
   * Reconcile process-local watches with the durable session registry.
   *
   * Losing one ephemeral member must not silently destroy a still-useful
   * safety watch. Retain valid watches over their remaining members and make
   * every membership change visible to the sentinel/operator. A watch that
   * falls below the two-member invariant is explicitly invalidated.
   */
  async reconcileFleetWatches(validSessions: ReadonlySet<string>): Promise<FleetWatchMembershipChange[]> {
    const changes: FleetWatchMembershipChange[] = [];
    const retained: FleetWatchState[] = [];

    for (const watch of [...this.fleetWatches.values()]) {
      const removedSessions = watch.sessions.filter((session) => !validSessions.has(session));
      if (removedSessions.length === 0) continue;

      const remainingSessions = watch.sessions.filter((session) => validSessions.has(session));
      this.cancelFleetConfirmation(watch);
      watch.notified = false;

      if (remainingSessions.length >= 2) {
        watch.sessions = remainingSessions;
        retained.push(watch);
        changes.push({
          name: watch.name,
          removedSessions,
          remainingSessions,
          action: 'continued',
        });
      } else {
        this.disarmFleetWatch(watch.name);
        changes.push({
          name: watch.name,
          removedSessions,
          remainingSessions,
          action: 'invalidated',
        });
      }
    }

    for (const session of [...this.stalledSessions]) {
      if (!validSessions.has(session)) this.stalledSessions.delete(session);
    }

    for (const watch of retained) {
      if (this.fleetWatches.get(watch.name) === watch) this.evaluateFleetWatch(watch);
    }
    // Membership notifications are important observability, but an adapter
    // failure must never prevent the retained safety watch from evaluating.
    const notifications = await Promise.allSettled(
      changes.map((change) => this.reportFleetWatchMembershipChange(change)),
    );
    for (const [index, result] of notifications.entries()) {
      if (result.status !== 'rejected') continue;
      log().warn(
        'sentinel',
        `Fleet-watch membership notification failed for '${changes[index]?.name ?? 'unknown'}': ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`,
      );
    }
    return changes;
  }

  /** Any successfully submitted work clears fleet-stall state and rearms affected watches. */
  noteWorking(session: string): void {
    if (!this.stalledSessions.delete(session)) return;
    for (const watch of this.fleetWatches.values()) {
      if (!watch.sessions.includes(session)) continue;
      this.cancelFleetConfirmation(watch);
      watch.notified = false;
    }
  }

  async handleStall(session: string, kind: StallKind, info: StallInfo): Promise<void> {
    this.deps.logEvent(session, `stall_${kind}`, info.reason);

    // The sentinel spends its life idle between stalls — that is its normal
    // state, not an emergency. Its own stalls are logged and otherwise
    // ignored; the meaningful "watcher is down" signal is a stall that cannot
    // be DELIVERED because the sentinel is not running (below).
    if (this.isSentinel(session)) {
      log().debug('sentinel', `${session}: ${kind} stall ignored (the sentinel idles by design)`);
      return;
    }

    // A second completed turn is proof the session worked between stalls even
    // when its runtime has no turn-start event (Codex). Treat it as a recovery
    // boundary before recording the new stall.
    if (this.stalledSessions.has(session)) this.noteWorking(session);
    this.stalledSessions.add(session);
    for (const watch of this.fleetWatches.values()) {
      if (watch.sessions.includes(session)) this.evaluateFleetWatch(watch);
    }

    if (!this.deps.isAuto(session) || this.deps.isPaused(session)) {
      log().debug('sentinel', `${session}: ${kind} stall ignored (auto is off or paused)`);
      return;
    }

    const capture = await this.captureStripped(session);

    const last = this.lastRouted.get(session);
    if (
      last !== undefined &&
      Date.now() - last.at < this.deps.config.suppressWindowMs &&
      contentSimilarity(capture, last.capture) > this.deps.config.suppressSimilarity
    ) {
      this.deps.logEvent(session, 'stall_suppressed', `similar ${kind} stall within window`);
      return;
    }

    this.lastRouted.set(session, { capture, at: Date.now() });

    // No sentinel is a perfectly fine setup: the stall goes straight to the
    // operator as a plain report — no queue (nothing would drain it), no
    // suggestion to configure one.
    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      const summary = info.reason !== undefined ? `: ${truncate(info.reason, 120)}` : '';
      this.deps.logEvent(session, 'stall_reported', `${kind} → operator`);
      await this.deps.notifyOperator(`⚠️ ${session} stalled (${kind})${summary}`);
      return;
    }

    // Sentinel not running: the stall cannot be delivered — this is the one
    // genuinely alarming state, reported to the operator (rate-limited).
    if (!(await this.deps.isActive(sentinel))) {
      const now = Date.now();
      if (now - this.lastSentinelDownWarnAt > SENTINEL_DOWN_WARN_INTERVAL_MS) {
        this.lastSentinelDownWarnAt = now;
        await this.deps.notifyOperator(`⚠️ ${session} stalled (${kind}) but sentinel ${sentinel} is not running.`);
      }
      return;
    }

    // One self-contained message: session, kind, and the (truncated) last
    // assistant message it stalled on. Everything else the sentinel needs it
    // gets with primitives (tail_session for the pane, send_to_session to
    // nudge, send_to_operator to ask; doing nothing dismisses).
    const lastMessage =
      (await this.readTranscript(session, info.transcriptPath)) ?? info.reason ?? '(no last message available)';
    this.deps.logEvent(session, 'stall_routed', `${kind} → ${sentinel}`);
    await this.deps.deliver(sentinel, stallEnvelope(session, kind, `last: ${truncate(lastMessage, 400)}`));
  }

  stop(): void {
    for (const watch of this.fleetWatches.values()) {
      if (watch.timer !== undefined) clearTimeout(watch.timer);
    }
  }

  private evaluateFleetWatch(watch: FleetWatchState): void {
    if (watch.notified || watch.allStalledAt !== undefined) return;
    if (!watch.sessions.every((session) => this.stalledSessions.has(session))) return;

    watch.allStalledAt = Date.now();
    if (watch.thresholdSeconds <= 0) {
      void this.reportFleetStall(watch);
      return;
    }
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      if (!watch.sessions.every((session) => this.stalledSessions.has(session))) return;
      void this.reportFleetStall(watch);
    }, watch.thresholdSeconds * 1000);
    watch.timer.unref();
  }

  private cancelFleetConfirmation(watch: FleetWatchState): void {
    if (watch.timer !== undefined) clearTimeout(watch.timer);
    watch.timer = undefined;
    watch.allStalledAt = undefined;
  }

  private async reportFleetStall(watch: FleetWatchState): Promise<void> {
    if (watch.notified || !watch.sessions.every((session) => this.stalledSessions.has(session))) return;
    watch.notified = true;
    const detail = `all stalled for ${String(watch.thresholdSeconds)}s: ${watch.sessions.join(', ')}`;
    this.deps.logEvent(`fleet:${watch.name}`, 'fleet_stall', detail);

    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      await this.deps.notifyOperator(`🚨 Fleet '${watch.name}' stalled: ${watch.sessions.join(', ')}.`);
      return;
    }
    if (!(await this.deps.isActive(sentinel))) {
      await this.deps.notifyOperator(
        `🚨 Fleet '${watch.name}' stalled (${watch.sessions.join(', ')}) but sentinel ${sentinel} is not running.`,
      );
      return;
    }
    await this.deps.deliver(sentinel, fleetStallEnvelope(watch.name, watch.sessions, watch.thresholdSeconds));
  }

  private async reportFleetWatchMembershipChange(change: FleetWatchMembershipChange): Promise<void> {
    const removed = change.removedSessions.join(',');
    const remaining = change.remainingSessions.length > 0 ? change.remainingSessions.join(',') : 'none';
    const continued = change.action === 'continued';
    const text = continued
      ? `[Fleet Watch] watch=${change.name} membership changed: removed=${removed} remaining=${remaining}. Watch continues with the same confirmation threshold.`
      : `[Fleet Watch] watch=${change.name} invalidated: removed=${removed} remaining=${remaining}. At least two registered sessions are required; re-arm after choosing a valid group.`;
    const event = continued ? 'fleet_watch_membership_changed' : 'fleet_watch_invalidated';
    this.deps.logEvent(`fleet:${change.name}`, event, `removed ${removed}; remaining ${remaining}`);
    log().warn('sentinel', text);

    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      await this.deps.notifyOperator(`⚠️ ${text}`);
      return;
    }
    if (!(await this.deps.isActive(sentinel))) {
      await this.deps.notifyOperator(`⚠️ ${text} Sentinel ${sentinel} is not running.`);
      return;
    }
    await this.deps.deliver(sentinel, text);
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
}
