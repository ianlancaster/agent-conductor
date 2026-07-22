import type { ClassifiedChannelInput } from '../classify.js';

export interface SlackSocketRequest {
  ack(response?: Record<string, unknown>): Promise<void>;
  envelope_id?: string;
  type: string;
  body: unknown;
}

export interface SlackSocketClient {
  on(event: 'slack_event', listener: (request: SlackSocketRequest) => void): unknown;
  off(event: 'slack_event', listener: (request: SlackSocketRequest) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SlackWebClient {
  auth: { test(): Promise<unknown> };
  conversations: { open(args: { users: string }): Promise<unknown> };
  chat: { postMessage(args: SlackPostMessage): Promise<unknown> };
}

export interface SlackPostMessage {
  channel: string;
  text: string;
  blocks?: Record<string, unknown>[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export interface SlackClients {
  socket: SlackSocketClient;
  web: SlackWebClient;
}

export interface SlackClientFactory {
  create(config: { appToken: string; botToken: string }): Promise<SlackClients>;
}

export interface SlackIdentity {
  teamId: string;
  operatorUserId: string;
  dmChannelId: string;
  botUserId: string;
}

export interface ClassifiedSlackEnvelope {
  dedupKey: string;
  input: ClassifiedChannelInput;
}
