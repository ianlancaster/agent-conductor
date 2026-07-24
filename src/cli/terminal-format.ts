const GREEN = '\u001b[32m';
const DEFAULT_FOREGROUND = '\u001b[39m';
const BOLD = '\u001b[1m';
const NORMAL_INTENSITY = '\u001b[22m';

/** Apply presentation that belongs to the local terminal, never to shared adapter text. */
export function formatTerminalReply(command: string, reply: string, colors: boolean): string {
  if (!colors) return reply;

  if (/^\/status(?:\s|$)/i.test(command.trim())) {
    return reply
      .split('\n')
      .map((line) => {
        if (/^(?:Agent Conductor Status(?: 🔄)?|PR Shepherd Status Online)$/.test(line)) {
          return `${BOLD}${line}${NORMAL_INTENSITY}`;
        }

        const fleetRow = /^( {2})(.+)( - (?:CC|codex)(?: (?:🛡|🐑))* · .+)$/.exec(line);
        if (fleetRow !== null) {
          return `${fleetRow[1]}${BOLD}${fleetRow[2]}${NORMAL_INTENSITY}${fleetRow[3]}`;
        }

        const detailedCodename = /^(\s*"codename": )(.+?)(,?)$/.exec(line);
        if (detailedCodename !== null) {
          return `${detailedCodename[1]}${BOLD}${detailedCodename[2]}${NORMAL_INTENSITY}${detailedCodename[3]}`;
        }

        return line;
      })
      .join('\n');
  }

  if (!/^\/help(?:\s|$)/i.test(command.trim())) return reply;

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
