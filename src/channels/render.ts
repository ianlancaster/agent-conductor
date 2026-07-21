import type { ChannelMessage } from './types.js';

/** Render semantic actions as explicit commands for text-only interfaces. */
export function renderChannelMessage(message: ChannelMessage): string {
  if (message.actions === undefined || message.actions.length === 0) return message.text;
  const options = message.actions.map((action, index) => `  ${String(index + 1)}. ${action.label} — ${action.command}`);
  return `${message.text}\n\nOptions:\n${options.join('\n')}`;
}
