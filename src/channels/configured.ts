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

/** Construct the package's explicitly enabled operator channels. */
export function buildConfiguredChannels(config: SupervisorConfig, env: NodeJS.ProcessEnv): ChannelAdapter[] {
  const values = {
    telegramToken: credential(env, 'CONDUCTOR_TELEGRAM_TOKEN'),
    telegramChatId: credential(env, 'CONDUCTOR_TELEGRAM_CHAT_ID'),
    slackBotToken: credential(env, 'CONDUCTOR_SLACK_BOT_TOKEN'),
    slackAppToken: credential(env, 'CONDUCTOR_SLACK_APP_TOKEN'),
    slackOperatorUserId: credential(env, 'CONDUCTOR_SLACK_OPERATOR_USER_ID'),
  };
  const missing = [
    ...(config.channels.telegram.enabled && values.telegramToken === undefined ? ['CONDUCTOR_TELEGRAM_TOKEN'] : []),
    ...(config.channels.telegram.enabled && values.telegramChatId === undefined ? ['CONDUCTOR_TELEGRAM_CHAT_ID'] : []),
    ...(config.channels.slack.enabled && values.slackBotToken === undefined ? ['CONDUCTOR_SLACK_BOT_TOKEN'] : []),
    ...(config.channels.slack.enabled && values.slackAppToken === undefined ? ['CONDUCTOR_SLACK_APP_TOKEN'] : []),
    ...(config.channels.slack.enabled && values.slackOperatorUserId === undefined
      ? ['CONDUCTOR_SLACK_OPERATOR_USER_ID']
      : []),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Enabled operator channels require ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} missing or blank. ` +
        'Set the value(s) in the fleet .conductor/.env or inherited environment, or disable the corresponding channel.',
    );
  }

  const channels: ChannelAdapter[] = [];
  if (config.channels.telegram.enabled) {
    channels.push(
      new TelegramAdapter({
        botToken: validatedCredential(values.telegramToken, 'CONDUCTOR_TELEGRAM_TOKEN'),
        chatId: validatedCredential(values.telegramChatId, 'CONDUCTOR_TELEGRAM_CHAT_ID'),
      }),
    );
  }
  if (config.channels.slack.enabled) {
    channels.push(
      new SlackAdapter({
        botToken: validatedCredential(values.slackBotToken, 'CONDUCTOR_SLACK_BOT_TOKEN'),
        appToken: validatedCredential(values.slackAppToken, 'CONDUCTOR_SLACK_APP_TOKEN'),
        operatorUserId: validatedCredential(values.slackOperatorUserId, 'CONDUCTOR_SLACK_OPERATOR_USER_ID'),
      }),
    );
  }
  return channels;
}
