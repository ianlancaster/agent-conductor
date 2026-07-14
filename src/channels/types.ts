export interface ChannelChoice {
  label: string;
  /** Opaque payload returned via onCallback when the choice is picked. */
  data: string;
}

export interface ChannelSendOptions {
  /** Rows of choices. Adapters without button support render numbered fallbacks. */
  buttons?: ChannelChoice[][];
}

export interface ChannelHandlers {
  /** A slash command, e.g. command="status", args=["midgard-1"]. Returns the reply text. */
  onCommand(command: string, args: string[]): Promise<string>;
  /** Free text (no leading slash). Returns an optional reply. */
  onFreeText(text: string): Promise<string | undefined>;
  /** A button press / choice selection. Returns an optional acknowledgement. */
  onCallback(data: string): Promise<string | undefined>;
}

export interface ChannelCapabilities {
  buttons: boolean;
}

/**
 * The seam between the conductor and an operator communication channel
 * (Telegram, Slack, Discord, local CLI).
 */
export interface ChannelAdapter {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;

  start(handlers: ChannelHandlers): Promise<void>;
  send(text: string, opts?: ChannelSendOptions): Promise<void>;
  stop(): Promise<void>;
}
