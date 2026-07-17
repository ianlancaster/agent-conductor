import type { ChannelChoice } from '../channels/types.js';
import { log } from '../logger.js';
import type { Autonomy } from './types.js';

interface PendingQuestion {
  id: number;
  session: string;
  question: string;
  options: string[] | undefined;
  resolve(answer: string): void;
}

export interface HumanInputDeps {
  notifyOperator(text: string, buttons?: ChannelChoice[][]): Promise<unknown>;
  sentinelCodename(): string | undefined;
  isActive(session: string): boolean;
  getAutonomy(session: string): Autonomy;
  deliver(session: string, text: string): Promise<unknown>;
}

/**
 * In-memory `request_human_input` round-trip (replaces the escalation queue).
 * Facilitated sessions ask the operator directly (buttons when the channel has
 * them); autonomous sessions ask the sentinel, which answers or escalates.
 */
export class HumanInputBroker {
  private readonly pending = new Map<number, PendingQuestion>();
  private nextId = 1;

  constructor(private readonly deps: HumanInputDeps) {}

  async request(session: string, question: string, context?: string, options?: string[]): Promise<string> {
    const id = this.nextId;
    this.nextId += 1;

    const answer = new Promise<string>((resolve) => {
      this.pending.set(id, { id, session, question, options, resolve });
    });

    const sentinel = this.deps.sentinelCodename();
    const routeToSentinel =
      this.deps.getAutonomy(session) === 'autonomous' &&
      sentinel !== undefined &&
      sentinel !== session &&
      this.deps.isActive(sentinel);

    if (routeToSentinel) {
      const lines = [`[HumanInput #${id} from ${session}] ${question}`];
      if (context !== undefined) lines.push(`Context: ${context}`);
      if (options !== undefined && options.length > 0) lines.push(`Options: ${options.join(' | ')}`);
      lines.push(`Answer with answer_human_input (id=${id}), or escalate to the operator if you are unsure.`);
      await this.deps.deliver(sentinel, lines.join('\n'));
    } else {
      const buttons =
        options !== undefined && options.length > 0
          ? options.map((option, index) => [{ label: option, data: `hi:${id}:${index}` }])
          : undefined;
      const lines = [`❓ *${session}* asks:`, question];
      if (context !== undefined) lines.push('', context);
      lines.push('', `Reply with buttons or \`/answer ${id} <text>\`.`);
      await this.deps.notifyOperator(lines.join('\n'), buttons);
    }

    log().info('human-input', `${session}: question #${id} pending (${routeToSentinel ? 'sentinel' : 'operator'})`);
    return answer;
  }

  /** Resolve a pending question with free-text. Returns the asking session, or undefined if unknown id. */
  answer(id: number, text: string): string | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) return undefined;
    this.pending.delete(id);
    pending.resolve(text);
    return pending.session;
  }

  /** Resolve via a button press (option index). */
  answerByOption(id: number, optionIndex: number): string | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) return undefined;
    const option = pending.options?.[optionIndex];
    if (option === undefined) return undefined;
    this.pending.delete(id);
    pending.resolve(option);
    return pending.session;
  }

  listPending(): { id: number; session: string; question: string }[] {
    return [...this.pending.values()].map(({ id, session, question }) => ({ id, session, question }));
  }
}
