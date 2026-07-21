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
  status: 'delivered' | 'queued';
  deduplicated: boolean;
}

export function renderMessageReceipt(receipt: MessageReceipt): string {
  const action = receipt.status === 'delivered' ? 'Delivered' : 'Queued';
  const duplicate = receipt.deduplicated ? ' (deduplicated)' : '';
  return `${action} message #${String(receipt.messageId)} for ${receipt.recipient}${duplicate}.`;
}

/** Inter-session and session-to-operator messaging primitives behind the MCP tools. */
export class Messaging {
  /** Message ids already represented in the in-memory delivery queue. */
  private readonly scheduled = new Set<number>();

  constructor(private readonly deps: MessagingDeps) {}

  async sendToSession(from: string, target: string, message: string, idempotencyKey?: string): Promise<MessageReceipt> {
    if (idempotencyKey !== undefined) {
      const existing = this.deps.store.getDirectMessageByIdempotencyKey(from, idempotencyKey);
      if (existing !== undefined) return this.receipt(existing, true);
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
        status: result === 'delivered' ? 'delivered' : 'queued',
        deduplicated: false,
      };
    }

    // Prevent the lifecycle's on-running recovery hook from scheduling this
    // same row while startSession is still launching it as the initial prompt.
    this.scheduled.add(id);
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
          status: result === 'delivered' ? 'delivered' : 'queued',
          deduplicated: false,
        };
      }
      if (started !== `${target} started.`) {
        return { messageId: id, recipient: target, status: 'queued', deduplicated: false };
      }
      this.deps.store.markMessageDelivered(id);
      return { messageId: id, recipient: target, status: 'delivered', deduplicated: false };
    } finally {
      if (releaseStartReservation) this.scheduled.delete(id);
    }
  }

  /**
   * Rebuild the in-memory queue from durable pending direct messages. Called
   * after pane adoption and whenever an agent starts, so a conductor or agent
   * restart cannot strand a successful-looking `send_to_session` result.
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
      inMemoryPendingForRecipient: this.deps.delivery.pendingCount(row.recipient),
    });
  }

  private async schedule(id: number, target: string, envelope: string): Promise<DeliveryResult> {
    this.scheduled.add(id);
    try {
      const result = await this.deps.delivery.deliverOrQueue(target, envelope, {
        onDelivered: () => {
          this.deps.store.markMessageDelivered(id);
          this.scheduled.delete(id);
        },
      });
      if (result === 'no-pane') this.scheduled.delete(id);
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
      status: row.status === 'delivered' ? 'delivered' : 'queued',
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
