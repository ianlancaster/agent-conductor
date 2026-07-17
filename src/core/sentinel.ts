import { log } from '../logger.js';
import type { SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { StallInfo } from './health.js';
import { contentSimilarity, stallEnvelope, truncate } from './utils.js';
import type { Autonomy, PaneRef, StallEvent, StallKind, StallResolution } from './types.js';

const NO_SENTINEL_WARN_INTERVAL_MS = 10 * 60 * 1000;

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
  getAutonomy(session: string): Autonomy;
  isActive(session: string): boolean;
  deliver(session: string, text: string): Promise<unknown>;
  notifyOperator(text: string): Promise<unknown>;
  logEvent(session: string, event: string, detail?: string): void;
}

/**
 * Routes ALL stalls of autonomous sessions to the designated sentinel session,
 * which decides what to do (nudge / suppress / escalate). The conductor's only
 * judgments are mechanical: dedup suppression and watchdog-over-sentinel.
 */
export class StallSentinelRouter {
  private queue: StallEvent[] = [];
  private nextId = 1;
  private readonly lastRouted = new Map<string, { capture: string; at: number }>();
  private lastNoSentinelWarnAt = 0;

  constructor(private readonly deps: SentinelDeps) {}

  sentinelCodename(): string | undefined {
    return this.deps.config.sentinelCodename;
  }

  isSentinel(caller: string): boolean {
    return this.deps.config.sentinelCodename !== undefined && caller === this.deps.config.sentinelCodename;
  }

  async handleStall(session: string, kind: StallKind, info: StallInfo): Promise<void> {
    this.deps.logEvent(session, `stall_${kind}`, info.reason);

    // Watchdog-over-sentinel: if the watcher itself stalls, go straight to the operator.
    if (this.isSentinel(session)) {
      await this.deps.notifyOperator(`⚠️ Sentinel *${session}* itself stalled (${kind}). The fleet is unsupervised.`);
      return;
    }

    if (this.deps.getAutonomy(session) !== 'autonomous') {
      log().debug('sentinel', `${session}: ${kind} stall ignored (facilitated — operator drives)`);
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

    const event: StallEvent = {
      id: this.nextId,
      session,
      kind,
      reason: info.reason,
      paneCapture: capture,
      lastAssistantMessage: await this.readTranscript(session, info.transcriptPath),
      createdAt: Date.now(),
    };
    this.nextId += 1;
    this.queue.push(event);
    this.lastRouted.set(session, { capture, at: event.createdAt });
    this.deps.logEvent(session, 'stall_routed', `#${event.id} ${kind}`);

    const sentinel = this.deps.config.sentinelCodename;
    if (sentinel === undefined || !this.deps.isActive(sentinel)) {
      const now = Date.now();
      if (now - this.lastNoSentinelWarnAt > NO_SENTINEL_WARN_INTERVAL_MS) {
        this.lastNoSentinelWarnAt = now;
        await this.deps.notifyOperator(
          sentinel === undefined
            ? `⚠️ *${session}* stalled (${kind}) but no sentinel is configured. Set sentinel.codename or switch the session to facilitated.`
            : `⚠️ *${session}* stalled (${kind}) but sentinel *${sentinel}* is not running. Stalls are queueing.`,
        );
      }
      return;
    }

    const summary = info.reason !== undefined ? truncate(info.reason, 120) : '';
    await this.deps.deliver(
      sentinel,
      stallEnvelope(session, kind, `#${event.id} ${summary} — call get_stall_queue for details, then resolve_stall.`),
    );
  }

  pendingStalls(): StallEvent[] {
    return [...this.queue];
  }

  async resolve(id: number, resolution: StallResolution, resolver: string): Promise<string> {
    const index = this.queue.findIndex((event) => event.id === id);
    if (index === -1) return `No pending stall #${id}.`;
    const event = this.queue[index];
    if (event === undefined) return `No pending stall #${id}.`;
    this.queue.splice(index, 1);

    switch (resolution.action) {
      case 'nudge': {
        const result = await this.deps.deliver(event.session, `[Sentinel] ${resolution.text}`);
        this.deps.logEvent(event.session, 'stall_nudged', `#${id} by ${resolver}: ${truncate(resolution.text, 200)}`);
        return `Nudge ${String(result)} to ${event.session}.`;
      }
      case 'suppress':
        this.deps.logEvent(
          event.session,
          'stall_dismissed',
          `#${id} by ${resolver}${resolution.note !== undefined ? `: ${resolution.note}` : ''}`,
        );
        return `Stall #${id} dismissed.`;
      case 'escalate': {
        await this.deps.notifyOperator(`❓ *${event.session}* (stall #${id}, via ${resolver}): ${resolution.question}`);
        this.deps.logEvent(event.session, 'stall_escalated', `#${id}: ${truncate(resolution.question, 200)}`);
        return `Escalated stall #${id} to the operator.`;
      }
    }
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
