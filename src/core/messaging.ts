import { log } from '../logger.js';
import type { Store } from '../store/index.js';
import type { SessionConfig } from '../config/schema.js';
import type { DeliveryQueue, DeliveryResult } from './delivery.js';
import type { SessionStateManager } from './state.js';
import { broadcastEnvelope, messageEnvelope } from './utils.js';

export interface MessagingDeps {
  store: Store;
  delivery: DeliveryQueue;
  states: SessionStateManager;
  sessions(): Map<string, SessionConfig>;
  startSession(codename: string, opts: { prompt?: string }): Promise<string>;
}

/** Inter-session and session-to-operator messaging primitives behind the MCP tools. */
export class Messaging {
  /** Message ids already represented in the in-memory delivery queue. */
  private readonly scheduled = new Set<number>();

  constructor(private readonly deps: MessagingDeps) {}

  async sendToSession(from: string, target: string, message: string): Promise<string> {
    if (!this.deps.sessions().has(target)) return `Unknown session: ${target}`;
    if (target === from) return 'Cannot send a message to yourself.';
    const envelope = messageEnvelope(from, message);
    const id = this.deps.store.insertMessage(from, target, 'message', message);

    if (this.deps.states.get(target)?.running === true) {
      const result = await this.schedule(id, target, envelope);
      if (result === 'no-pane') return `${target} has no pane — message #${String(id)} stored but undelivered.`;
      if (result === 'delivered') return `Delivered message #${String(id)} to ${target}.`;
      return `Queued message #${String(id)} for ${target} (input is occupied; ${String(this.deps.delivery.pendingCount(target))} pending).`;
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
        if (result === 'delivered') return `Delivered message #${String(id)} to ${target}.`;
        if (result === 'queued') {
          return `Queued message #${String(id)} for ${target} (input is occupied; ${String(this.deps.delivery.pendingCount(target))} pending).`;
        }
        return `${target} has no pane — message #${String(id)} stored but undelivered.`;
      }
      if (started !== `${target} started.`) {
        return `${target} did not start — message #${String(id)} remains pending. (${started})`;
      }
      this.deps.store.markMessageDelivered(id);
      return `${target} was not running — started with your message #${String(id)}. (${started})`;
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
    const result = await this.deps.delivery.deliverOrQueue(target, envelope, {
      onDelivered: () => {
        this.deps.store.markMessageDelivered(id);
        this.scheduled.delete(id);
      },
    });
    if (result === 'no-pane') this.scheduled.delete(id);
    return result;
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
