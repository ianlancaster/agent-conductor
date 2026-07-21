import type { ChannelAdapter, ChannelHandlers, ChannelMessage } from '../../src/channels/types.js';

/** In-memory ChannelAdapter for tests. Drive it with command()/freeText(). */
export class FakeChannel implements ChannelAdapter {
  readonly name = 'fake';

  readonly sent: ChannelMessage[] = [];
  private handlers: ChannelHandlers | undefined;

  async start(handlers: ChannelHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async send(message: ChannelMessage): Promise<void> {
    this.sent.push(message);
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
  }

  // ── test drivers ──────────────────────────────────────────────────────────

  command(command: string, args: string[] = [], conversationId = 'test'): Promise<string> {
    return this.mustHandlers().onCommand(command, args, { conversationId });
  }

  freeText(text: string, conversationId = 'test'): Promise<string | undefined> {
    return this.mustHandlers().onFreeText(text, { conversationId });
  }

  lastSent(): ChannelMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  private mustHandlers(): ChannelHandlers {
    if (!this.handlers) throw new Error('FakeChannel not started');
    return this.handlers;
  }
}
