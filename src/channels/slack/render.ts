import type { ChannelAction, ChannelMessage } from '../types.js';
import { splitMessage } from '../split.js';

export const SLACK_MAX_SECTION_LENGTH = 3000;
const SLACK_MAX_FALLBACK_LENGTH = 4000;
const SLACK_MAX_ACTION_VALUE_LENGTH = 2000;
const SLACK_MAX_ACTION_ID_LENGTH = 255;
const SLACK_MAX_ACTION_LABEL_LENGTH = 75;

export interface SlackPost {
  text: string;
  blocks?: Record<string, unknown>[];
}

/** Neutralize Slack mrkdwn entities and mention syntax in agent-authored text. */
export function escapeSlackText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderSlackPosts(message: ChannelMessage): SlackPost[] {
  const escaped = escapeSlackText(message.text);
  const chunks = splitMessage(escaped, SLACK_MAX_SECTION_LENGTH);
  const actions = validateActions(message.actions);
  if (escaped.length === 0 && actions.length === 0) return [];
  if (chunks.length === 0) chunks.push('Choose an option:');

  return chunks.map((chunk, index) => {
    if (index !== chunks.length - 1 || actions.length === 0) return { text: chunk };
    const blocks: Record<string, unknown>[] = [
      { type: 'section', text: { type: 'mrkdwn', text: chunk || 'Choose an option:' } },
      {
        type: 'actions',
        elements: actions.map((action, actionIndex) => ({
          type: 'button',
          action_id: `conductor_action_${String(actionIndex)}`,
          text: { type: 'plain_text', text: buttonLabel(action.label), emoji: true },
          value: action.command,
        })),
      },
    ];
    return { text: accessibleFallback(chunk, actions), blocks };
  });
}

function validateActions(actions: readonly ChannelAction[] | undefined): readonly ChannelAction[] {
  if (actions === undefined) return [];
  if (actions.length > 8) throw new Error('Slack messages support at most 8 actions');
  for (const [index, action] of actions.entries()) {
    const actionId = `conductor_action_${String(index)}`;
    if (action.label.length < 1) throw new Error('Slack action label must not be empty');
    if (action.command.length < 1 || action.command.length > SLACK_MAX_ACTION_VALUE_LENGTH) {
      throw new Error(`Slack action command must be between 1 and ${String(SLACK_MAX_ACTION_VALUE_LENGTH)} characters`);
    }
    if (actionId.length > SLACK_MAX_ACTION_ID_LENGTH) throw new Error('Slack action id exceeds 255 characters');
  }
  return actions;
}

function buttonLabel(label: string): string {
  return Array.from(label).slice(0, SLACK_MAX_ACTION_LABEL_LENGTH).join('');
}

function accessibleFallback(chunk: string, actions: readonly ChannelAction[]): string {
  const labels = actions.map((action, index) => `${String(index + 1)}. ${escapeSlackText(action.label)}`).join('\n');
  const suffix = `\n\nOptions:\n${labels}`;
  if (suffix.length >= SLACK_MAX_FALLBACK_LENGTH) return suffix.slice(0, SLACK_MAX_FALLBACK_LENGTH);
  return `${chunk.slice(0, SLACK_MAX_FALLBACK_LENGTH - suffix.length)}${suffix}`;
}
