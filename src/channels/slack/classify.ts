import { classifySlashInput, type ClassifiedChannelInput } from '../classify.js';
import type { ClassifiedSlackEnvelope, SlackIdentity, SlackSocketRequest } from './types.js';

interface SlackMessageEvent {
  type?: unknown;
  subtype?: unknown;
  user?: unknown;
  channel?: unknown;
  channel_type?: unknown;
  text?: unknown;
  bot_id?: unknown;
}

interface EventsApiBody {
  team_id?: unknown;
  event_id?: unknown;
  event?: SlackMessageEvent;
}

interface InteractiveBody {
  type?: unknown;
  team?: { id?: unknown };
  user?: { id?: unknown };
  channel?: { id?: unknown };
  actions?: { action_id?: unknown; value?: unknown }[];
}

/** Classify the Slack App Home syntax without involving conductor policy. */
export function classifySlackText(text: string): ClassifiedChannelInput {
  if (text.startsWith('!!')) return { kind: 'freeText', text: text.slice(1) };
  if (text.slice(1).trim().length === 0 && text.startsWith('!')) {
    return { kind: 'command', command: 'help', args: [] };
  }
  if (text.startsWith('!send') && (text.length === 5 || /\s/.test(text[5] ?? ''))) {
    const payload = text.slice(5).trimStart();
    return payload.length === 0 ? { kind: 'command', command: 'help', args: [] } : { kind: 'freeText', text: payload };
  }
  if (!text.startsWith('!')) return { kind: 'freeText', text };

  const commandText = text.slice(1).trimStart();
  return classifySlashInput(commandText.startsWith('/') ? commandText : `/${commandText}`);
}

/**
 * Authenticate and classify one already-acknowledged Socket Mode envelope.
 * Identity comes exclusively from Slack-authenticated fields and the startup
 * identity tuple; payload text never gets to claim an operator identity.
 */
export function classifySlackEnvelope(
  request: Pick<SlackSocketRequest, 'type' | 'body' | 'envelope_id'>,
  identity: SlackIdentity,
): ClassifiedSlackEnvelope | undefined {
  if (request.type === 'events_api') {
    if (!isObject(request.body)) return undefined;
    const body = request.body as EventsApiBody;
    const event = body.event;
    if (
      body.team_id !== identity.teamId ||
      event?.type !== 'message' ||
      event.user !== identity.operatorUserId ||
      event.channel !== identity.dmChannelId ||
      event.channel_type !== 'im' ||
      event.bot_id !== undefined ||
      event.user === identity.botUserId ||
      event.subtype !== undefined ||
      typeof event.text !== 'string' ||
      event.text.length === 0
    ) {
      return undefined;
    }
    const key = typeof body.event_id === 'string' ? body.event_id : request.envelope_id;
    return key === undefined ? undefined : { dedupKey: key, input: classifySlackText(event.text) };
  }

  if (request.type === 'interactive') {
    if (!isObject(request.body)) return undefined;
    const body = request.body as InteractiveBody;
    const action = body.actions?.[0];
    const value = action?.value;
    if (
      body.type !== 'block_actions' ||
      body.team?.id !== identity.teamId ||
      body.user?.id !== identity.operatorUserId ||
      body.channel?.id !== identity.dmChannelId ||
      typeof action?.action_id !== 'string' ||
      !action.action_id.startsWith('conductor_action_') ||
      typeof value !== 'string' ||
      request.envelope_id === undefined
    ) {
      return undefined;
    }
    const input = classifySlashInput(value);
    return input.kind === 'command' ? { dedupKey: request.envelope_id, input } : undefined;
  }

  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
