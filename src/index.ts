export { Supervisor } from './core/supervisor.js';
export type { SupervisorOptions } from './core/supervisor.js';
export type { SupervisorConfig, SessionConfig, SpawnTemplate } from './config/schema.js';
export type { DeliveryCapture, TerminalBackend } from './terminals/types.js';
export type { SessionRuntime } from './runtimes/types.js';
export type {
  ChannelAction,
  ChannelAdapter,
  ChannelContext,
  ChannelHandlers,
  ChannelMessage,
} from './channels/types.js';
export { renderChannelMessage } from './channels/render.js';
export { SlackAdapter } from './channels/slack/index.js';
export type { SlackAdapterConfig, SlackAdapterOptions } from './channels/slack/index.js';
export { TelegramAdapter } from './channels/telegram/index.js';
export type { TelegramAdapterConfig } from './channels/telegram/index.js';
export * from './shepherd/index.js';
