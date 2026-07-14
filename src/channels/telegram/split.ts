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
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
