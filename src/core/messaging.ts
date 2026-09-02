import { log } from '../logger.js';
import type { DeliveryPausePolicy, MessageRow, Store } from '../store/index.js';
import type { SessionConfig } from '../config/schema.js';
import type { DeliveryQueue } from './delivery.js';
import type { SessionStateManager } from './state.js';
import { broadcastEnvelope, integrationEnvelope, messageEnvelope } from './utils.js';
import { InvalidRequestError } from './errors.js';
import type { ConductorEventPublisher } from '../events/types.js';

export interface MessagingDeps {
  store: Store;
  delivery: DeliveryQueue;
  states: SessionStateManager;
  sessions(): Map<string, SessionConfig>;
  startSession(codename: string, opts: { prompt?: string }): Promise<string>;
  /** High-visibility notice prepended to operator input while automation is paused. */
  pausedNotice?(codename: string): string | undefined;
  events?: ConductorEventPublisher;
}

export interface MessageReceipt {
  messageId: number;
  recipient: string;
  /** Destination fleet for a remotely routed receipt; absent for local delivery. */
  fleet?: string;
  status: 'delivered' | 'queued' | 'cancelled';
  deduplicated: boolean;
  /** Operator-visible warning associated with this delivery, when applicable. */
  notice?: string;
}

export function isMessageReceipt(value: unknown): value is MessageReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as Partial<MessageReceipt>;
  return (
    typeof receipt.messageId === 'number' &&
    typeof receipt.recipient === 'string' &&
    (receipt.status === 'delivered' || receipt.status === 'queued' || receipt.status === 'cancelled') &&
    typeof receipt.deduplicated === 'boolean' &&
    (receipt.notice === undefined || typeof receipt.notice === 'string')
  );
}

export function renderMessageReceipt(receipt: MessageReceipt): string {
  const action = receipt.status === 'delivered' ? 'Delivered' : receipt.status === 'cancelled' ? 'Cancelled' : 'Queued';
  const duplicate = receipt.deduplicated ? ' (deduplicated)' : '';
  const destination = receipt.fleet === undefined ? receipt.recipient : `${receipt.recipient}@${receipt.fleet}`;
  const acknowledgement = `${action} message #${String(receipt.messageId)} for ${destination}${duplicate}.`;
  return receipt.notice === undefined ? acknowledgement : `${acknowledgement}\n${receipt.notice}`;
}

/** Durable inter-session and operator-to-session messaging behind the canonical tools. */
export class Messaging {
  /** Message ids already represented in the in-memory delivery queue or an initial-prompt launch. */
  private readonly scheduled = new Set<number>();
  /** Initial-prompt launches have crossed the cancellation boundary. */
  private readonly startingDelivery = new Set<number>();
  /** Serializes database admission, initial prompt selection, and cancellation for each recipient. */
  private readonly recipientAdmissions = new Map<string, Promise<void>>();
  private recoveryTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly deps: MessagingDeps) {}

  async sendToSession(
    from: string,
    target: string,
    message: string,
    idempotencyKey?: string,
    pausePolicy: DeliveryPausePolicy = 'hold',
  ): Promise<MessageReceipt> {
    const notice = pausePolicy === 'bypass' ? this.deps.pausedNotice?.(target) : undefined;
    return this.sendProtected(
      from,
      target,
      message,
      (content) => {
        const envelope = messageEnvelope(from, content);
        return notice === undefined ? envelope : `${notice}\n\n${envelope}`;
      },
      pausePolicy,
      idempotencyKey,
      notice,
      from === 'pr-shepherd',
    );
  }

  /** Narrow trusted path used only by IntegrationManager. */
  async sendIntegrationToSession(
    integrationName: string,
    target: string,
    message: string,
    idempotencyKey: string,
  ): Promise<MessageReceipt> {
    return this.sendProtected(
      `integration:${integrationName}`,
      target,
      message,
      (content) => integrationEnvelope(integrationName, content),
      'hold',
      idempotencyKey,
      undefined,
      true,
    );
  }

  private async sendProtected(
    from: string,
    target: string,
    message: string,
    envelopeFor: (persistedContent: string) => string,
    pausePolicy: DeliveryPausePolicy,
    idempotencyKey?: string,
    notice?: string,
    rejectWhilePaused = false,
  ): Promise<MessageReceipt> {
    if (idempotencyKey !== undefined) {
      const existing = this.deps.store.getDirectMessageByIdempotencyKey(from, idempotencyKey);
      if (
        existing !== undefined &&
        !(existing.status === 'cancelled' && existing.flush_skip_reason === 'conductor-restarted')
      ) {
        if (existing.status === 'pending') await this.admitOrRetain(existing.recipient, true);
        return this.receipt(this.deps.store.getMessage(existing.id) ?? existing, true, notice);
      }
    }
    if (!this.deps.sessions().has(target)) throw new InvalidRequestError(`Unknown session: ${target}`);
    if (target === from) throw new InvalidRequestError('Cannot send a message to yourself.');
    if (rejectWhilePaused && this.deps.states.isPaused(target)) {
      throw new Error(`${target} is paused; automated delivery from ${from} is deferred until it resumes.`);
    }

    const envelope = envelopeFor(message);
    const inserted = this.deps.store.insertDirectMessage(from, target, message, idempotencyKey, {
      policy: pausePolicy,
      envelope,
    });
    const id = inserted.row.id;
    if (!inserted.deduplicated) {
      this.deps.events?.emit({
        type: 'message.created',
        receiptId: id,
        sender: from,
        recipient: target,
        byteCount: Buffer.byteLength(message, 'utf8'),
      });
    }

    await this.admitOrRetain(target, true);
    return this.receipt(this.deps.store.getMessage(id) ?? inserted.row, inserted.deduplicated, notice);
  }

  /** Recover pending rows without starting stopped recipients merely to empty a queue. */
  async recoverPendingMessages(recipient?: string): Promise<void> {
    const recipients =
      recipient === undefined
        ? [...new Set(this.deps.store.getPendingDeliveries().map((row) => row.recipient))]
        : [recipient];
    for (const target of recipients) {
      await this.admitRecipient(target, false);
    }
    await this.deps.delivery.drainNow();
  }

  /** Startup rollback forgets only in-memory admission; SQLite remains authoritative. */
  resetRecovery(): void {
    this.scheduled.clear();
    this.startingDelivery.clear();
    this.recipientAdmissions.clear();
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  stop(): void {
    this.stopped = true;
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  messageStatus(id: number, requester?: string): string {
    const row = this.deps.store.getMessage(id);
    if (
      row?.type !== 'message' ||
      (requester !== undefined && row.sender !== requester && row.recipient !== requester)
    ) {
      return requester === undefined
        ? `Message #${String(id)} was not found.`
        : `Message #${String(id)} was not found or is not part of your conversation. Receipt ids are fleet-wide; this response does not indicate a ledger gap.`;
    }
    return JSON.stringify({
      id: row.id,
      sender: row.sender,
      recipient: row.recipient,
      type: row.type,
      status: row.status,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      lastFlushAttempt: row.last_flush_attempt_at,
      flushSkipReason: row.flush_skip_reason,
      cancelledAt: row.cancelled_at,
      inMemoryPendingForRecipient: this.deps.delivery.pendingCount(row.recipient),
    });
  }

  async cancelMessage(id: number, requester?: string): Promise<string> {
    const initial = this.deps.store.getMessage(id);
    if (initial?.type !== 'message') return `Message #${String(id)} was not found.`;
    return this.withRecipient(initial.recipient, async () => {
      const row = this.deps.store.getMessage(id);
      if (row?.type !== 'message' || (requester !== undefined && row.sender !== requester)) {
        return `Message #${String(id)} was not found.`;
      }
      if (row.status === 'delivered') return `Message #${String(id)} was already delivered and cannot be cancelled.`;
      if (row.status === 'cancelled') return `Message #${String(id)} is already cancelled.`;
      if (this.startingDelivery.has(id)) {
        return `Message #${String(id)} is already being written and can no longer be cancelled.`;
      }

      const result = this.deps.delivery.cancel(row.recipient, id);
      if (result === 'in-flight') {
        return `Message #${String(id)} is already being written and can no longer be cancelled.`;
      }
      if (!this.deps.store.markMessageCancelled(id)) {
        const current = this.deps.store.getMessage(id);
        return current?.status === 'delivered'
          ? `Message #${String(id)} was already delivered and cannot be cancelled.`
          : `Message #${String(id)} could not be cancelled.`;
      }
      this.scheduled.delete(id);
      this.deps.events?.emit({
        type: 'message.cancelled',
        receiptId: id,
        sender: row.sender,
        recipient: row.recipient,
        reason: 'requested',
      });
      return `Message #${String(id)} cancelled.`;
    });
  }

  async broadcast(
    from: string,
    message: string,
    allowed: (codename: string) => boolean = () => true,
    pausePolicy: DeliveryPausePolicy = 'hold',
  ): Promise<string> {
    const recipients = this.deps.states.activeSessions().filter((codename) => allowed(codename) && codename !== from);
    const rows = this.deps.store.insertBroadcastDeliveries(from, recipients, message, (recipient) => {
      const notice = pausePolicy === 'bypass' ? this.deps.pausedNotice?.(recipient) : undefined;
      const envelope = broadcastEnvelope(from, message);
      return { policy: pausePolicy, envelope: notice === undefined ? envelope : `${notice}\n\n${envelope}` };
    });

    let retainedForRecovery = 0;
    const results = await Promise.allSettled(recipients.map((recipient) => this.admitRecipient(recipient, false)));
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      retainedForRecovery += rows.filter((row) => row.recipient === recipients[index]).length;
      log().warn(
        'messaging',
        `broadcast to ${recipients[index] ?? 'unknown'} retained for recovery: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
    if (retainedForRecovery > 0) this.ensureRecoveryTimer();
    const current = rows.map((row) => this.deps.store.getMessage(row.id) ?? row);
    const delivered = current.filter((row) => row.status === 'delivered').length;
    const queued = current.filter((row) => row.status === 'pending').length - retainedForRecovery;
    if (queued === 0 && retainedForRecovery === 0) return `Broadcast delivered to ${String(delivered)} session(s).`;
    return (
      `Broadcast accepted for ${String(rows.length)} session(s): ${String(delivered)} delivered, ` +
      `${String(Math.max(0, queued))} queued, ${String(retainedForRecovery)} retained for recovery.`
    );
  }

  private async admitOrRetain(recipient: string, startIfNeeded: boolean): Promise<void> {
    try {
      await this.admitRecipient(recipient, startIfNeeded);
    } catch (error) {
      log().warn(
        'messaging',
        `${recipient}: durable delivery admission failed; retaining for retry: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.ensureRecoveryTimer();
    }
  }

  private admitRecipient(recipient: string, startIfNeeded: boolean): Promise<void> {
    return this.withRecipient(recipient, async () => {
      if (!this.deps.sessions().has(recipient)) return;
      const allPending = this.deps.store.getPendingDeliveries(recipient);
      let pending = allPending.filter((row) => !this.scheduled.has(row.id));
      if (pending.length === 0) return;

      const running = this.deps.states.get(recipient)?.running === true;
      const olderAlreadyScheduled = allPending.some((row) => this.scheduled.has(row.id));
      if (!running && !startIfNeeded) return;
      if (!running && startIfNeeded && !olderAlreadyScheduled) {
        const paused = this.deps.states.isPaused(recipient);
        const first = pending.find((row) => row.delivery_policy === 'bypass' || !paused);
        if (first === undefined) return;
        const release = this.deps.delivery.acquireSubmissionLease(recipient, first.delivery_policy);
        if (release === undefined) return;
        this.scheduled.add(first.id);
        this.startingDelivery.add(first.id);
        try {
          const started = await this.deps.startSession(recipient, { prompt: this.envelope(first) });
          if (started === `${recipient} started.`) this.markDelivered(first.id);
          else if (started !== `${recipient} is already running.`) {
            this.scheduled.delete(first.id);
            throw new Error(started);
          } else {
            this.scheduled.delete(first.id);
          }
        } catch (error) {
          this.scheduled.delete(first.id);
          throw error;
        } finally {
          this.startingDelivery.delete(first.id);
          release();
        }
      }

      pending = this.deps.store.getPendingDeliveries(recipient).filter((row) => !this.scheduled.has(row.id));
      for (const row of pending) this.enqueue(row);
      await this.deps.delivery.drainNow();
    });
  }

  private enqueue(row: MessageRow): void {
    this.deps.delivery.enqueueOnly(row.recipient, this.envelope(row), {
      pausePolicy: row.delivery_policy,
      deliveryId: row.id,
      onAttempt: (skipReason) => {
        this.deps.store.recordMessageFlushAttempt(row.id, skipReason);
      },
      onDelivered: () => {
        this.markDelivered(row.id);
        this.scheduled.delete(row.id);
      },
    });
    if (this.deps.store.getMessage(row.id)?.status === 'pending') this.scheduled.add(row.id);
  }

  private envelope(row: MessageRow): string {
    if (row.delivery_envelope !== null) return row.delivery_envelope;
    if (row.type === 'broadcast') return broadcastEnvelope(row.sender, row.content);
    if (row.sender.startsWith('integration:'))
      return integrationEnvelope(row.sender.slice('integration:'.length), row.content);
    return messageEnvelope(row.sender, row.content);
  }

  private markDelivered(id: number): void {
    this.scheduled.delete(id);
    if (!this.deps.store.markMessageDelivered(id)) return;
    const row = this.deps.store.getMessage(id);
    if (row?.type !== 'message') return;
    this.deps.events?.emit({
      type: 'message.delivered',
      receiptId: row.id,
      sender: row.sender,
      recipient: row.recipient,
    });
  }

  private receipt(row: MessageRow, deduplicated: boolean, notice?: string): MessageReceipt {
    return {
      messageId: row.id,
      recipient: row.recipient,
      status: row.status === 'delivered' ? 'delivered' : row.status === 'cancelled' ? 'cancelled' : 'queued',
      deduplicated,
      ...(notice === undefined ? {} : { notice }),
    };
  }

  private withRecipient<T>(recipient: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.recipientAdmissions.get(recipient) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.recipientAdmissions.set(recipient, settled);
    void settled.finally(() => {
      if (this.recipientAdmissions.get(recipient) === settled) this.recipientAdmissions.delete(recipient);
    });
    return current;
  }

  private ensureRecoveryTimer(): void {
    if (this.stopped || this.recoveryTimer !== undefined) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.retryUnscheduled();
    }, this.deps.delivery.queueDrainMs());
    this.recoveryTimer.unref();
  }

  private async retryUnscheduled(): Promise<void> {
    try {
      await this.recoverPendingMessages();
    } catch (error) {
      log().warn(
        'messaging',
        `durable delivery recovery retry failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      this.deps.store
        .getPendingDeliveries()
        .some((row) => this.deps.sessions().has(row.recipient) && !this.scheduled.has(row.id))
    ) {
      this.ensureRecoveryTimer();
    }
  }
}
