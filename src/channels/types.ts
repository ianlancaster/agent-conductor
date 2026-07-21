export interface ChannelContext {
  /** Stable identifier for one operator conversation within an adapter. */
  conversationId: string;
}

export interface ChannelHandlers {
  /** A slash command, e.g. command="status", args=["project-1"]. Returns the reply text. */
  onCommand(command: string, args: string[], context: ChannelContext): Promise<string>;
  /** Free text (no leading slash). Returns an optional reply. */
  onFreeText(text: string, context: ChannelContext): Promise<string | undefined>;
}

export interface ChannelAction {
  /** Text shown by the operator interface. */
  label: string;
  /** Canonical operator command invoked when selected. */
  command: string;
}

export interface ChannelMessage {
  text: string;
  actions?: readonly ChannelAction[];
}

/**
 * The seam between the conductor and an operator communication channel
 * (Telegram, Slack, Discord, local CLI).
 */
export interface ChannelAdapter {
  readonly name: string;

  start(handlers: ChannelHandlers): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
  stop(): Promise<void>;
}
