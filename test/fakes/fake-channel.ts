import type { ChannelAdapter, ChannelHandlers } from '../../src/channels/types.js';

/** In-memory ChannelAdapter for tests. Drive it with command()/freeText(). */
export class FakeChannel implements ChannelAdapter {
  readonly name = 'fake';

  readonly sent: string[] = [];
  private handlers: ChannelHandlers | undefined;

  async start(handlers: ChannelHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async send(text: string): Promise<void> {
    this.sent.push(text);
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
  }

  // ── test drivers ──────────────────────────────────────────────────────────

  command(command: string, args: string[] = []): Promise<string> {
    return this.mustHandlers().onCommand(command, args);
  }

  freeText(text: string): Promise<string | undefined> {
    return this.mustHandlers().onFreeText(text);
  }

  lastSent(): string | undefined {
    return this.sent[this.sent.length - 1];
  }

  private mustHandlers(): ChannelHandlers {
    if (!this.handlers) throw new Error('FakeChannel not started');
    return this.handlers;
  }
}
