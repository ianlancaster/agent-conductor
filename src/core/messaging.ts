import { log } from '../logger.js';
import type { MessageRow, Store } from '../store/index.js';
import type { SessionConfig } from '../config/schema.js';
import type { DeliveryQueue, DeliveryResult } from './delivery.js';
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
  events?: ConductorEventPublisher;
}

export interface MessageReceipt {
  messageId: number;
  recipient: string;
  /** Destination fleet for a remotely routed receipt; absent for local delivery. */
  fleet?: string;
  status: 'delivered' | 'queued' | 'cancelled';
  deduplicated: boolean;
}

export function isMessageReceipt(value: unknown): value is MessageReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as Partial<MessageReceipt>;
  return (
    typeof receipt.messageId === 'number' &&
    typeof receipt.recipient === 'string' &&
    (receipt.status === 'delivered' || receipt.status === 'queued' || receipt.status === 'cancelled') &&
    typeof receipt.deduplicated === 'boolean'
  );
}

export function renderMessageReceipt(receipt: MessageReceipt): string {
  const action = receipt.status === 'delivered' ? 'Delivered' : receipt.status === 'cancelled' ? 'Cancelled' : 'Queued';
  const duplicate = receipt.deduplicated ? ' (deduplicated)' : '';
  const destination = receipt.fleet === undefined ? receipt.recipient : `${receipt.recipient}@${receipt.fleet}`;
  return `${action} message #${String(receipt.messageId)} for ${destination}${duplicate}.`;
}

/** Inter-session and session-to-operator messaging primitives behind the MCP tools. */
export class Messaging {
  /** Message ids already represented in the in-memory delivery queue. */
  private readonly scheduled = new Set<number>();
  /** Initial-prompt launches have crossed the cancellation boundary. */
  private readonly startingDelivery = new Set<number>();
  /** Trusted envelopes for current-run pending messages with non-session presentation. */
  private readonly pendingEnvelopes = new Map<number, string>();

  constructor(private readonly deps: MessagingDeps) {}

  async sendToSession(from: string, target: string, message: string, idempotencyKey?: string): Promise<MessageReceipt> {
    return this.sendProtected(
      from,
      target,
      message,
      (content) => messageEnvelope(from, content),
      idempotencyKey,
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
      idempotencyKey,
      true,
    );
  }

  private async sendProtected(
    from: string,
    target: string,
    message: string,
    envelopeFor: (persistedContent: string) => string,
    idempotencyKey?: string,
    automated = false,
  ): Promise<MessageReceipt> {
    if (idempotencyKey !== undefined) {
      const existing = this.deps.store.getDirectMessageByIdempotencyKey(from, idempotencyKey);
      if (
        existing !== undefined &&
        !(existing.status === 'cancelled' && existing.flush_skip_reason === 'conductor-restarted')
      ) {
        if (existing.status === 'pending') {
          this.pendingEnvelopes.set(existing.id, envelopeFor(existing.content));
        }
        return this.receipt(existing, true);
      }
    }
    if (!this.deps.sessions().has(target)) throw new InvalidRequestError(`Unknown session: ${target}`);
    if (target === from) throw new InvalidRequestError('Cannot send a message to yourself.');
    if (automated && this.deps.states.isPaused(target)) {
      throw new Error(`${target} is paused; automated delivery from ${from} is deferred until it resumes.`);
    }
    const inserted = this.deps.store.insertDirectMessage(from, target, message, idempotencyKey);
    const id = inserted.row.id;
    const envelope = envelopeFor(inserted.row.content);
    if (inserted.row.status === 'pending') this.pendingEnvelopes.set(id, envelope);

    if (inserted.deduplicated) {
      return this.receipt(inserted.row, true);
    }
    this.deps.events?.emit({
      type: 'message.created',
      receiptId: id,
      sender: from,
      recipient: target,
      byteCount: Buffer.byteLength(message, 'utf8'),
    });

    if (this.deps.states.get(target)?.running === true) {
      const result = await this.schedule(id, target, envelope, automated);
      return {
        messageId: id,
        recipient: target,
        status: result === 'delivered' ? 'delivered' : result === 'cancelled' ? 'cancelled' : 'queued',
        deduplicated: false,
      };
    }

    // Prevent the lifecycle's on-running recovery hook from scheduling this
    // same row while startSession is still launching it as the initial prompt.
    this.scheduled.add(id);
    this.startingDelivery.add(id);
    let releaseStartReservation = true;
    try {
      const started = await this.deps.startSession(target, { prompt: envelope });
      if (started === `${target} is already running.`) {
        this.scheduled.delete(id);
        releaseStartReservation = false; // schedule() now owns this id until its receipt fires.
        const result = await this.schedule(id, target, envelope, automated);
        return {
          messageId: id,
          recipient: target,
          status: result === 'delivered' ? 'delivered' : result === 'cancelled' ? 'cancelled' : 'queued',
          deduplicated: false,
        };
      }
      if (started !== `${target} started.`) {
        return { messageId: id, recipient: target, status: 'queued', deduplicated: false };
      }
      this.markDelivered(id);
      return { messageId: id, recipient: target, status: 'delivered', deduplicated: false };
    } finally {
      this.startingDelivery.delete(id);
      if (releaseStartReservation) this.scheduled.delete(id);
    }
  }

  /**
   * Schedule pending messages created during this conductor run when a target
   * pane becomes available. Startup cancels local pending rows from earlier
   * runs before any lifecycle callback can reach this method.
   */
  async recoverPendingMessages(recipient?: string): Promise<void> {
    for (const row of this.deps.store.getPendingMessages(recipient)) {
      if (this.scheduled.has(row.id)) continue;
      if (!this.deps.sessions().has(row.recipient)) continue;
      if (this.deps.states.get(row.recipient)?.running !== true) continue;
      await this.schedule(
        row.id,
        row.recipient,
        this.pendingEnvelopes.get(row.id) ?? messageEnvelope(row.sender, row.content),
        row.sender === 'pr-shepherd' || row.sender.startsWith('integration:'),
      );
    }
    await this.deps.delivery.drainNow();
  }

  messageStatus(id: number, requester?: string): string {
    const row = this.deps.store.getMessage(id);
    if (row === undefined || (requester !== undefined && row.sender !== requester && row.recipient !== requester)) {
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

  cancelMessage(id: number, requester?: string): string {
    const row = this.deps.store.getMessage(id);
    // A session may cancel only its own outbound message. Do not reveal other
    // sessions' receipt ids through a different error shape.
    if (row === undefined || (requester !== undefined && row.sender !== requester)) {
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
    this.pendingEnvelopes.delete(id);
    this.deps.events?.emit({
      type: 'message.cancelled',
      receiptId: id,
      sender: row.sender,
      recipient: row.recipient,
      reason: 'requested',
    });
    return `Message #${String(id)} cancelled.`;
  }

  private async schedule(id: number, target: string, envelope: string, automated = false): Promise<DeliveryResult> {
    this.scheduled.add(id);
    try {
      const result = await this.deps.delivery.deliverOrQueue(target, envelope, {
        automated,
        deliveryId: id,
        onAttempt: (skipReason) => {
          this.deps.store.recordMessageFlushAttempt(id, skipReason);
        },
        onDelivered: () => {
          this.markDelivered(id);
          this.scheduled.delete(id);
          this.pendingEnvelopes.delete(id);
        },
      });
      if (result === 'no-pane' || result === 'cancelled') {
        this.scheduled.delete(id);
        if (result === 'cancelled') this.pendingEnvelopes.delete(id);
      }
      return result;
    } catch (error) {
      this.scheduled.delete(id);
      throw error;
    }
  }

  private markDelivered(id: number): void {
    this.pendingEnvelopes.delete(id);
    if (!this.deps.store.markMessageDelivered(id)) return;
    const row = this.deps.store.getMessage(id);
    if (row === undefined) return;
    this.deps.events?.emit({
      type: 'message.delivered',
      receiptId: row.id,
      sender: row.sender,
      recipient: row.recipient,
    });
  }

  private receipt(row: MessageRow, deduplicated: boolean): MessageReceipt {
    return {
      messageId: row.id,
      recipient: row.recipient,
      status: row.status === 'delivered' ? 'delivered' : row.status === 'cancelled' ? 'cancelled' : 'queued',
      deduplicated,
    };
  }

  async broadcast(from: string, message: string, allowed: (codename: string) => boolean = () => true): Promise<string> {
    const envelope = broadcastEnvelope(from, message);
    let delivered = 0;
    for (const codename of this.deps.states.activeSessions()) {
      if (!allowed(codename)) continue;
      if (codename === from) continue;
      try {
        await this.deps.delivery.deliverOrQueue(codename, envelope);
        delivered += 1;
      } catch (err) {
        log().warn('messaging', `broadcast to ${codename} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.deps.store.insertMessage(from, '*', 'broadcast', message);
    return `Broadcast delivered to ${delivered} session(s).`;
  }
}
