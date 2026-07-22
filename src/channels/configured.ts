import type { SupervisorConfig } from '../config/schema.js';
import { TelegramAdapter } from './telegram/index.js';
import type { ChannelAdapter } from './types.js';

function credential(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Construct the package's explicitly enabled operator channels. */
export function buildConfiguredChannels(config: SupervisorConfig, env: NodeJS.ProcessEnv): ChannelAdapter[] {
  if (!config.channels.telegram.enabled) return [];

  const botToken = credential(env, 'CONDUCTOR_TELEGRAM_TOKEN');
  const chatId = credential(env, 'CONDUCTOR_TELEGRAM_CHAT_ID');
  if (botToken === undefined || chatId === undefined) {
    const missing = [
      ...(botToken === undefined ? ['CONDUCTOR_TELEGRAM_TOKEN'] : []),
      ...(chatId === undefined ? ['CONDUCTOR_TELEGRAM_CHAT_ID'] : []),
    ];
    throw new Error(
      `Telegram is enabled but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing or blank. ` +
        'Set the value(s) in the fleet .conductor/.env or inherited environment, or disable channels.telegram.',
    );
  }

  return [new TelegramAdapter({ botToken, chatId })];
}
