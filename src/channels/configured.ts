import type { SupervisorConfig } from '../config/schema.js';
import { SlackAdapter } from './slack/index.js';
import { TelegramAdapter } from './telegram/index.js';
import type { ChannelAdapter } from './types.js';

function credential(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function validatedCredential(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`Internal error: ${name} was not validated`);
  return value;
}

export interface UnavailableConfiguredChannel {
  name: string;
  reason: string;
}

export interface ConfiguredChannels {
  channels: ChannelAdapter[];
  unavailable: UnavailableConfiguredChannel[];
}

/**
 * Construct the package's explicitly enabled operator channels. Missing
 * credentials degrade only that optional channel; they must never prevent the
 * conductor's lifecycle and messaging control plane from starting.
 */
export function buildConfiguredChannels(config: SupervisorConfig, env: NodeJS.ProcessEnv): ConfiguredChannels {
  const values = {
    telegramToken: credential(env, 'CONDUCTOR_TELEGRAM_TOKEN'),
    telegramChatId: credential(env, 'CONDUCTOR_TELEGRAM_CHAT_ID'),
    slackBotToken: credential(env, 'CONDUCTOR_SLACK_BOT_TOKEN'),
    slackAppToken: credential(env, 'CONDUCTOR_SLACK_APP_TOKEN'),
    slackOperatorUserId: credential(env, 'CONDUCTOR_SLACK_OPERATOR_USER_ID'),
  };
  const channels: ChannelAdapter[] = [];
  const unavailable: UnavailableConfiguredChannel[] = [];
  if (config.channels.telegram.enabled) {
    const missing = [
      ...(values.telegramToken === undefined ? ['CONDUCTOR_TELEGRAM_TOKEN'] : []),
      ...(values.telegramChatId === undefined ? ['CONDUCTOR_TELEGRAM_CHAT_ID'] : []),
    ];
    if (missing.length > 0) {
      unavailable.push({ name: 'telegram', reason: `missing or blank: ${missing.join(', ')}` });
    } else {
      channels.push(
        new TelegramAdapter({
          botToken: validatedCredential(values.telegramToken, 'CONDUCTOR_TELEGRAM_TOKEN'),
          chatId: validatedCredential(values.telegramChatId, 'CONDUCTOR_TELEGRAM_CHAT_ID'),
        }),
      );
    }
  }
  if (config.channels.slack.enabled) {
    const missing = [
      ...(values.slackBotToken === undefined ? ['CONDUCTOR_SLACK_BOT_TOKEN'] : []),
      ...(values.slackAppToken === undefined ? ['CONDUCTOR_SLACK_APP_TOKEN'] : []),
      ...(values.slackOperatorUserId === undefined ? ['CONDUCTOR_SLACK_OPERATOR_USER_ID'] : []),
    ];
    if (missing.length > 0) {
      unavailable.push({ name: 'slack', reason: `missing or blank: ${missing.join(', ')}` });
    } else {
      channels.push(
        new SlackAdapter({
          botToken: validatedCredential(values.slackBotToken, 'CONDUCTOR_SLACK_BOT_TOKEN'),
          appToken: validatedCredential(values.slackAppToken, 'CONDUCTOR_SLACK_APP_TOKEN'),
          operatorUserId: validatedCredential(values.slackOperatorUserId, 'CONDUCTOR_SLACK_OPERATOR_USER_ID'),
        }),
      );
    }
  }
  return { channels, unavailable };
}
