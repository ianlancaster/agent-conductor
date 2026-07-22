import { splitMessage as splitChannelMessage } from '../split.js';

/** Telegram's hard limit on the length of a single message. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Split a message into chunks no longer than `maxLen`.
 *
 * Prefers splitting at a paragraph boundary (`\n\n`), then a line boundary
 * (`\n`), and only hard-splits mid-line when neither exists in the second
 * half of the window (a very early boundary would produce a tiny chunk).
 * Leading whitespace on continuation chunks is trimmed.
 */
export function splitMessage(text: string, maxLen: number = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  return splitChannelMessage(text, maxLen);
}
