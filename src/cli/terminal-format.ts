const GREEN = '\u001b[32m';
const DEFAULT_FOREGROUND = '\u001b[39m';

/** Apply presentation that belongs to the local terminal, never to shared adapter text. */
export function formatTerminalReply(command: string, reply: string, colors: boolean): string {
  if (!colors || !/^\/help(?:\s|$)/i.test(command.trim())) return reply;

  return reply
    .split('\n')
    .map((line) => {
      // Primary help rows: color the command syntax, but leave its description plain.
      const commandRow = /^( {2,})(.+?)( — .+)$/.exec(line);
      if (commandRow !== null) {
        return `${commandRow[1]}${GREEN}${commandRow[2]}${DEFAULT_FOREGROUND}${commandRow[3]}`;
      }

      // Continuation rows contain only flags belonging to the command above.
      const continuation = /^( {4})(.+)$/.exec(line);
      if (continuation !== null) {
        return `${continuation[1]}${GREEN}${continuation[2]}${DEFAULT_FOREGROUND}`;
      }

      return line;
    })
    .join('\n');
}

/** Decode both legacy string feed frames and semantic ChannelMessage frames. */
export function formatFeedPayload(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object' || payload === null || typeof (payload as { text?: unknown }).text !== 'string') {
    return undefined;
  }
  return renderChannelMessage(payload as ChannelMessage);
}
import { renderChannelMessage } from '../channels/render.js';
import type { ChannelMessage } from '../channels/types.js';
