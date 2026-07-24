import { log } from '../logger.js';
import type { MessageRow, Store } from '../store/index.js';
import type { SessionConfig } from '../config/schema.js';
import type { DeliveryQueue, DeliveryResult } from './delivery.js';
import type { SessionStateManager } from './state.js';
import { broadcastEnvelope, messageEnvelope } from './utils.js';
import { InvalidRequestError } from './errors.js';

export interface MessagingDeps {
  store: Store;
  delivery: DeliveryQueue;
  states: SessionStateManager;
  sessions(): Map<string, SessionConfig>;
  startSession(codename: string, opts: { prompt?: string }): Promise<string>;
}

export interface MessageReceipt {
  messageId: number;
  recipient: string;
  status: 'delivered' | 'queued' | 'cancelled';
  deduplicated: boolean;
}

export function renderMessageReceipt(receipt: MessageReceipt): string {
  const action = receipt.status === 'delivered' ? 'Delivered' : receipt.status === 'cancelled' ? 'Cancelled' : 'Queued';
  const duplicate = receipt.deduplicated ? ' (deduplicated)' : '';
  return `${action} message #${String(receipt.messageId)} for ${receipt.recipient}${duplicate}.`;
}

/** Inter-session and session-to-operator messaging primitives behind the MCP tools. */
export class Messaging {
  /** Message ids already represented in the in-memory delivery queue. */
  private readonly scheduled = new Set<number>();
  /** Initial-prompt launches have crossed the cancellation boundary. */
  private readonly startingDelivery = new Set<number>();

  constructor(private readonly deps: MessagingDeps) {}

  async sendToSession(from: string, target: string, message: string, idempotencyKey?: string): Promise<MessageReceipt> {
    if (idempotencyKey !== undefined) {
      const existing = this.deps.store.getDirectMessageByIdempotencyKey(from, idempotencyKey);
      if (
        existing !== undefined &&
        !(existing.status === 'cancelled' && existing.flush_skip_reason === 'conductor-restarted')
      ) {
        return this.receipt(existing, true);
      }
    }
    if (!this.deps.sessions().has(target)) throw new InvalidRequestError(`Unknown session: ${target}`);
    if (target === from) throw new InvalidRequestError('Cannot send a message to yourself.');
    const envelope = messageEnvelope(from, message);
    const inserted = this.deps.store.insertDirectMessage(from, target, message, idempotencyKey);
    const id = inserted.row.id;

    if (inserted.deduplicated) {
      return this.receipt(inserted.row, true);
    }

    if (this.deps.states.get(target)?.running === true) {
      const result = await this.schedule(id, target, envelope);
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
        const result = await this.schedule(id, target, envelope);
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
      this.deps.store.markMessageDelivered(id);
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
      await this.schedule(row.id, row.recipient, messageEnvelope(row.sender, row.content));
    }
    await this.deps.delivery.drainNow();
  }

  messageStatus(id: number, requester?: string): string {
    const row = this.deps.store.getMessage(id);
    if (row === undefined || (requester !== undefined && row.sender !== requester && row.recipient !== requester)) {
      return `Message #${String(id)} was not found.`;
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
    return `Message #${String(id)} cancelled.`;
  }

  private async schedule(id: number, target: string, envelope: string): Promise<DeliveryResult> {
    this.scheduled.add(id);
    try {
      const result = await this.deps.delivery.deliverOrQueue(target, envelope, {
        deliveryId: id,
        onAttempt: (skipReason) => {
          this.deps.store.recordMessageFlushAttempt(id, skipReason);
        },
        onDelivered: () => {
          this.deps.store.markMessageDelivered(id);
          this.scheduled.delete(id);
        },
      });
      if (result === 'no-pane' || result === 'cancelled') this.scheduled.delete(id);
      return result;
    } catch (error) {
      this.scheduled.delete(id);
      throw error;
    }
  }

  private receipt(row: MessageRow, deduplicated: boolean): MessageReceipt {
    return {
      messageId: row.id,
      recipient: row.recipient,
      status: row.status === 'delivered' ? 'delivered' : row.status === 'cancelled' ? 'cancelled' : 'queued',
      deduplicated,
    };
  }

  async broadcast(from: string, message: string): Promise<string> {
    const envelope = broadcastEnvelope(from, message);
    let delivered = 0;
    for (const codename of this.deps.states.activeSessions()) {
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
