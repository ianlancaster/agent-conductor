import { log } from '../logger.js';
import type { Store } from '../store/index.js';
import type { SessionConfig } from '../config/schema.js';
import type { DeliveryQueue } from './delivery.js';
import type { SessionStateManager } from './state.js';
import { broadcastEnvelope, messageEnvelope } from './utils.js';

export interface MessagingDeps {
  store: Store;
  delivery: DeliveryQueue;
  states: SessionStateManager;
  sessions(): Map<string, SessionConfig>;
  startSession(codename: string, opts: { prompt?: string }): Promise<string>;
  /** Send to the operator; resolves false when no channel is connected. */
  channelSend(text: string): Promise<boolean>;
}

/** Inter-session and session-to-operator messaging primitives behind the MCP tools. */
export class Messaging {
  constructor(private readonly deps: MessagingDeps) {}

  async sendToSession(from: string, target: string, message: string): Promise<string> {
    if (!this.deps.sessions().has(target)) return `Unknown session: ${target}`;
    if (target === from) return 'Cannot send a message to yourself.';
    const envelope = messageEnvelope(from, message);
    const id = this.deps.store.insertMessage(from, target, 'message', message);

    if (this.deps.states.get(target)?.running === true) {
      const result = await this.deps.delivery.deliverOrQueue(target, envelope);
      if (result === 'no-pane') return `${target} has no pane — message stored but undelivered.`;
      // Only mark the durable record delivered when it actually reached the
      // pane; a queued message may still be dropped, and the audit must not lie.
      if (result === 'delivered') {
        this.deps.store.markMessageDelivered(id);
        return `Delivered to ${target}.`;
      }
      return `Queued for ${target} (their input is busy).`;
    }

    const started = await this.deps.startSession(target, { prompt: envelope });
    this.deps.store.markMessageDelivered(id);
    return `${target} was not running — started with your message. (${started})`;
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

  notify(from: string, message: string, recipients?: string[]): string {
    const targets = (recipients ?? [...this.deps.sessions().keys()]).filter(
      (codename) => codename !== from && this.deps.sessions().has(codename),
    );
    for (const target of targets) {
      this.deps.store.insertMessage(from, target, 'notification', message);
    }
    return `Notification queued for ${targets.length} session(s) — delivered when they next start.`;
  }

  /** Deliver any queued notifications to a freshly started session. */
  async deliverPendingNotifications(codename: string): Promise<void> {
    for (const row of this.deps.store.getPendingMessages(codename)) {
      if (row.type !== 'notification') continue;
      try {
        await this.deps.delivery.deliverOrQueue(codename, messageEnvelope(row.sender, row.content));
        this.deps.store.markMessageDelivered(row.id);
      } catch (err) {
        log().warn(
          'messaging',
          `notification delivery to ${codename} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async respondToUser(from: string, message: string): Promise<string> {
    const sent = await this.deps.channelSend(`*${from}:* ${message}`);
    return sent ? 'Sent to the operator.' : 'No operator channel connected — message logged to the conductor console.';
  }
}
