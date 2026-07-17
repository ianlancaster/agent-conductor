export interface ChannelHandlers {
  /** A slash command, e.g. command="status", args=["midgard-1"]. Returns the reply text. */
  onCommand(command: string, args: string[]): Promise<string>;
  /** Free text (no leading slash). Returns an optional reply. */
  onFreeText(text: string): Promise<string | undefined>;
}

/**
 * The seam between the conductor and an operator communication channel
 * (Telegram, Slack, Discord, local CLI).
 */
export interface ChannelAdapter {
  readonly name: string;

  start(handlers: ChannelHandlers): Promise<void>;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
}
