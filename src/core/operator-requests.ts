import type { ChannelAction, ChannelMessage } from '../channels/types.js';
import type { Store } from '../store/index.js';
import { renderMessageReceipt, type Messaging } from './messaging.js';
import { InvalidRequestError } from './errors.js';
import { messageEnvelope } from './utils.js';
import type { ConductorEventPublisher } from '../events/types.js';
import type { OperatorSendOutcome } from './types.js';

const MAX_OPTIONS = 8;
const MAX_OPTION_LENGTH = 80;

export interface OperatorRequestsDeps {
  store: Store;
  messaging: Pick<Messaging, 'sendToSession'>;
  channelSend(message: ChannelMessage): Promise<OperatorSendOutcome>;
  events?: ConductorEventPublisher;
  /**
   * Whether sessions may raise selectable requests at all. Read per call rather
   * than captured, so a fleet that turns the capability off does not have to
   * restart to mean it.
   */
  allowOptions?(): boolean;
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
    // Refusal is decided by the PRESENCE of options, before validation and
    // before any row or event exists. A fleet that disables selectable requests
    // is disabling the capability, not rejecting a payload, so an empty or
    // malformed list is refused for the same stated reason rather than falling
    // through to a shape complaint that implies a well-formed list would work.
    if (rawOptions !== undefined && this.deps.allowOptions?.() === false) {
      throw new InvalidRequestError(
        'Selectable operator requests are disabled on this fleet. Send the message as prose without ' +
          "'options' — describe the choices in the text and ask the operator to reply in their own words.",
      );
    }
    if (rawOptions === undefined) {
      const outcome = await this.deps.channelSend({ text: messageEnvelope(from, message) });
      return this.receipt(outcome, 'Message');
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
    const outcome = await this.deps.channelSend({ text: messageEnvelope(from, message), actions });
    return this.receipt(outcome, `Request #${String(requestId)}`);
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
      const delivery = await this.deps.messaging.sendToSession('operator', request.session, response);
      if (!this.deps.store.finalizeOperatorRequest(requestId, selectedIndex)) {
        throw new Error(`Operator request #${String(requestId)} could not be finalized.`);
      }
      this.deps.events?.emit({
        type: 'operator.request.resolved',
        session: request.session,
        requestId,
        selectedOption: option,
      });
      const renderedDelivery = typeof delivery === 'string' ? delivery : renderMessageReceipt(delivery);
      return `${renderedDelivery} Response recorded: ${selected}`;
    } catch (error) {
      this.deps.store.releaseOperatorRequest(requestId);
      throw error;
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

  /**
   * One receipt for both the delivered and the held case.
   *
   * The previous wording named which one had happened, and that made operator
   * presence readable by any session in a single call — the capability
   * deliberately kept out of `list_sessions` by threading an audience through
   * it. It was not gratuitous: an honest failure receipt is what stopped a
   * session waiting forever on a question nobody received. The outbox is what
   * makes a uniform receipt true rather than reassuring, because a held message
   * is now genuinely going to arrive. Only a message that could be neither sent
   * nor held reports a failure, and that reports a storage fault rather than
   * whether anyone is watching.
   */
  private receipt(outcome: OperatorSendOutcome, subject: string): string {
    return outcome === 'lost'
      ? `${subject} could NOT be queued for the operator: the conductor failed to store it. Nothing was delivered and nothing is held — raise it again.`
      : `${subject} queued for the operator.`;
  }
}
