import type { ChannelAction, ChannelMessage } from '../channels/types.js';
import type { Store } from '../store/index.js';
import { isMessageQueueFullResult, renderMessageSendResult, type Messaging } from './messaging.js';
import { messageEnvelope } from './utils.js';
import type { ConductorEventPublisher } from '../events/types.js';
import type { OperatorSoundKind } from './operator-sound.js';

const MAX_OPTIONS = 8;
const MAX_OPTION_LENGTH = 80;

export interface OperatorRequestsDeps {
  store: Store;
  messaging: Pick<Messaging, 'sendToSession'>;
  channelSend(message: ChannelMessage): Promise<boolean>;
  events?: ConductorEventPublisher;
  /** Optional host alert after each delivered message; it must never affect delivery. */
  sound?: { notify(kind: OperatorSoundKind): void };
}

/** Correlates selectable operator questions with one ordinary session reply. */
export class OperatorRequests {
  constructor(private readonly deps: OperatorRequestsDeps) {}

  recoverStaleClaims(): number {
    // A crash after claiming but before finalizing must not strand the request.
    // Retrying can duplicate a response in that narrow window; an outbox would
    // be disproportionate for this communication-only primitive.
    return this.deps.store.resetRespondingOperatorRequests();
  }

  async send(from: string, message: string, rawOptions?: readonly string[]): Promise<string> {
    if (rawOptions === undefined) {
      const sent = await this.deps.channelSend({ text: messageEnvelope(from, message) });
      if (sent) this.alert('message');
      return sent ? 'Sent to the operator.' : this.notDelivered();
    }

    const options = this.normalizeOptions(rawOptions);
    const requestId = this.deps.store.insertOperatorRequest(from, message, options);
    this.deps.events?.emit({
      type: 'operator.request.created',
      session: from,
      requestId,
      optionCount: options.length,
    });
    const actions: ChannelAction[] = options.map((label, index) => ({
      label,
      command: `/respond ${String(requestId)} ${String(index + 1)}`,
    }));
    const sent = await this.deps.channelSend({ text: messageEnvelope(from, message), actions });
    if (sent) this.alert('choices');
    return sent ? `Request #${String(requestId)} sent to the operator.` : this.notDelivered();
  }

  async respond(requestId: number, option: number): Promise<string> {
    if (!Number.isInteger(requestId) || requestId < 1) throw new Error("'requestId' must be a positive integer");
    if (!Number.isInteger(option) || option < 1) throw new Error("'option' must be a positive integer");

    const request = this.deps.store.getOperatorRequest(requestId);
    if (request === undefined) return `Unknown operator request: #${String(requestId)}.`;
    if (option > request.options.length) {
      return `Operator request #${String(requestId)} has ${String(request.options.length)} option(s); choose 1–${String(request.options.length)}.`;
    }
    if (request.status !== 'pending') return this.resolvedState(request);
    if (!this.deps.store.claimOperatorRequest(requestId)) {
      const current = this.deps.store.getOperatorRequest(requestId);
      return current === undefined ? `Unknown operator request: #${String(requestId)}.` : this.resolvedState(current);
    }

    const selectedIndex = option - 1;
    const selected = request.options[selectedIndex];
    if (selected === undefined) {
      this.deps.store.releaseOperatorRequest(requestId);
      throw new Error(`Operator request #${String(requestId)} has invalid stored options.`);
    }
    const response = `Response to request #${String(requestId)} (${JSON.stringify(request.message)}): ${selected}`;
    try {
      const delivery = await this.deps.messaging.sendToSession(
        'operator',
        request.session,
        response,
        undefined,
        'bypass',
      );
      if (isMessageQueueFullResult(delivery)) {
        this.deps.store.releaseOperatorRequest(requestId);
        return renderMessageSendResult(delivery);
      }
      if (!this.deps.store.finalizeOperatorRequest(requestId, selectedIndex)) {
        throw new Error(`Operator request #${String(requestId)} could not be finalized.`);
      }
      this.deps.events?.emit({
        type: 'operator.request.resolved',
        session: request.session,
        requestId,
        selectedOption: option,
      });
      const renderedDelivery = typeof delivery === 'string' ? delivery : renderMessageSendResult(delivery);
      return `${renderedDelivery} Response recorded: ${selected}`;
    } catch (error) {
      this.deps.store.releaseOperatorRequest(requestId);
      throw error;
    }
  }

  private alert(kind: OperatorSoundKind): void {
    try {
      this.deps.sound?.notify(kind);
    } catch {
      // The alert is a courtesy; the message has already been delivered.
    }
  }

  private normalizeOptions(rawOptions: readonly string[]): string[] {
    if (rawOptions.length < 1 || rawOptions.length > MAX_OPTIONS) {
      throw new Error(`'options' must contain between 1 and ${String(MAX_OPTIONS)} choices`);
    }
    const options = rawOptions.map((option) => option.trim());
    for (const option of options) {
      if (option.length === 0) throw new Error("'options' choices must be non-empty strings");
      if (option.length > MAX_OPTION_LENGTH) {
        throw new Error(`'options' choices must be at most ${String(MAX_OPTION_LENGTH)} characters`);
      }
    }
    if (new Set(options).size !== options.length) {
      throw new Error("'options' choices must be unique after trimming");
    }
    return options;
  }

  private resolvedState(request: NonNullable<ReturnType<Store['getOperatorRequest']>>): string {
    if (request.status === 'responding') return `Operator request #${String(request.id)} is already being answered.`;
    const selected = request.selectedIndex === null ? undefined : request.options[request.selectedIndex];
    return `Operator request #${String(request.id)} was already answered${selected === undefined ? '.' : `: ${selected}`}`;
  }

  private notDelivered(): string {
    return 'NOT delivered: no operator interface accepted the message (no console attached and every channel was absent or failed). The message was only written to the conductor log — repeat it when an operator connects.';
  }
}
