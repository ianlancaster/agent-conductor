import { log } from '../logger.js';
import type { SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { StallInfo } from './health.js';
import { contentSimilarity, fleetStallEnvelope, stallEnvelope, truncate } from './utils.js';
import type { PaneRef, StallKind } from './types.js';

const SENTINEL_DOWN_WARN_INTERVAL_MS = 10 * 60 * 1000;

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
  isActive(session: string): boolean | Promise<boolean>;
  deliver(session: string, text: string): Promise<unknown>;
  notifyOperator(text: string): Promise<unknown>;
  logEvent(session: string, event: string, detail?: string): void;
  initialFleetWatchEnabled?: boolean;
  initialSessions?: Iterable<string>;
  onFleetWatchChanged?(enabled: boolean): void;
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
  private registeredSessions: Set<string>;
  private fleetWatchEnabled: boolean;
  private fleetAllStalledAt: number | undefined;
  private fleetNotified = false;
  private fleetTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SentinelDeps) {
    this.sentinel = deps.config.sentinelCodename;
    this.registeredSessions = new Set(deps.initialSessions ?? []);
    this.fleetWatchEnabled = deps.initialFleetWatchEnabled ?? false;
    this.evaluateFleetWatch();
  }

  sentinelCodename(): string | undefined {
    return this.sentinel;
  }

  setSentinel(codename: string | undefined): void {
    this.sentinel = codename;
    this.lastSentinelDownWarnAt = 0;
    this.resetFleetConfirmation();
    this.evaluateFleetWatch();
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
    if (setsEqual(this.registeredSessions, next)) return;
    this.registeredSessions = next;
    for (const session of [...this.stalledSessions]) {
      if (!next.has(session)) this.stalledSessions.delete(session);
    }
    this.resetFleetConfirmation();
    this.evaluateFleetWatch();
  }

  /** Any successfully submitted work clears fleet-stall state and rearms affected watches. */
  noteWorking(session: string): void {
    if (!this.stalledSessions.delete(session)) return;
    if (!this.fleetMembers().includes(session)) return;
    this.resetFleetConfirmation();
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
    this.evaluateFleetWatch();

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
    if (this.fleetTimer !== undefined) clearTimeout(this.fleetTimer);
  }

  private fleetMembers(): string[] {
    return [...this.registeredSessions].filter((session) => !this.isSentinel(session));
  }

  private evaluateFleetWatch(): void {
    if (!this.fleetWatchEnabled || this.fleetNotified || this.fleetAllStalledAt !== undefined) return;
    const sessions = this.fleetMembers();
    if (sessions.length < 2 || !sessions.every((session) => this.stalledSessions.has(session))) return;

    this.fleetAllStalledAt = Date.now();
    if (this.deps.config.fleetStallThresholdSeconds <= 0) {
      void this.reportFleetStall();
      return;
    }
    this.fleetTimer = setTimeout(() => {
      this.fleetTimer = undefined;
      const currentSessions = this.fleetMembers();
      if (currentSessions.length < 2 || !currentSessions.every((session) => this.stalledSessions.has(session))) {
        this.fleetAllStalledAt = undefined;
        return;
      }
      void this.reportFleetStall();
    }, this.deps.config.fleetStallThresholdSeconds * 1000);
    this.fleetTimer.unref();
  }

  private resetFleetConfirmation(): void {
    if (this.fleetTimer !== undefined) clearTimeout(this.fleetTimer);
    this.fleetTimer = undefined;
    this.fleetAllStalledAt = undefined;
    this.fleetNotified = false;
  }

  private async reportFleetStall(): Promise<void> {
    const sessions = this.fleetMembers();
    if (this.fleetNotified || sessions.length < 2 || !sessions.every((session) => this.stalledSessions.has(session))) {
      return;
    }
    this.fleetNotified = true;
    const thresholdSeconds = this.deps.config.fleetStallThresholdSeconds;
    const detail = `all stalled for ${String(thresholdSeconds)}s: ${sessions.join(', ')}`;
    this.deps.logEvent('fleet', 'fleet_stall', detail);

    const sentinel = this.sentinel;
    if (sentinel === undefined) {
      await this.deps.notifyOperator(`🚨 Fleet stalled: ${sessions.join(', ')}.`);
      return;
    }
    if (!(await this.deps.isActive(sentinel))) {
      await this.deps.notifyOperator(
        `🚨 Fleet stalled (${sessions.join(', ')}) but sentinel ${sentinel} is not running.`,
      );
      return;
    }
    await this.deps.deliver(sentinel, fleetStallEnvelope(sessions, thresholdSeconds));
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
