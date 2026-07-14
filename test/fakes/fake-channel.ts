import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelChoice,
  ChannelHandlers,
  ChannelSendOptions,
} from '../../src/channels/types.js';

export interface SentMessage {
  text: string;
  buttons?: ChannelChoice[][];
}

/** In-memory ChannelAdapter for tests. Drive it with command()/freeText()/callback(). */
export class FakeChannel implements ChannelAdapter {
  readonly name = 'fake';
  readonly capabilities: ChannelCapabilities = { buttons: true };

  readonly sent: SentMessage[] = [];
  private handlers: ChannelHandlers | undefined;

  async start(handlers: ChannelHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async send(text: string, opts?: ChannelSendOptions): Promise<void> {
    this.sent.push({ text, buttons: opts?.buttons });
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

  callback(data: string): Promise<string | undefined> {
    return this.mustHandlers().onCallback(data);
  }

  lastSent(): SentMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  private mustHandlers(): ChannelHandlers {
    if (!this.handlers) throw new Error('FakeChannel not started');
    return this.handlers;
  }
}
