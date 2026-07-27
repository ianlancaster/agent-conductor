import { setTimeout as delay } from 'node:timers/promises';

import { log } from '../../logger.js';
import type { ChannelAdapter, ChannelHandlers, ChannelMessage } from '../types.js';
import { classifySlackEnvelope } from './classify.js';
import { renderSlackPosts } from './render.js';
import { defaultSlackClientFactory } from './sdk.js';
import type { SlackClientFactory, SlackClients, SlackIdentity, SlackPostMessage, SlackSocketRequest } from './types.js';

const STARTUP_TIMEOUT_MS = 45_000;
const DEDUP_LIMIT = 500;
const SEND_INTERVAL_MS = 1_000;
const STOP_GRACE_MS = 5_000;

export interface SlackAdapterConfig {
  appToken: string;
  botToken: string;
  operatorUserId: string;
}

export interface SlackAdapterOptions {
  clientFactory?: SlackClientFactory;
  startupTimeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class SlackAdapter implements ChannelAdapter {
  readonly name = 'slack';

  private readonly config: SlackAdapterConfig;
  private readonly factory: SlackClientFactory;
  private readonly startupTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private clients: SlackClients | undefined;
  private handlers: ChannelHandlers | undefined;
  private identity: SlackIdentity | undefined;
  private dispatchTail: Promise<void> = Promise.resolve();
  private sendTail: Promise<void> = Promise.resolve();
  private lastSendAt = 0;
  private accepting = false;
  private generation = 0;
  private readonly recentKeys = new Set<string>();
  private readonly socketListener = (request: SlackSocketRequest): void => {
    this.queueEnvelope(request, this.generation);
  };

  constructor(config: SlackAdapterConfig, options: SlackAdapterOptions = {}) {
    if (!config.appToken || !config.botToken || !config.operatorUserId) {
      throw new Error('SlackAdapter requires appToken, botToken, and operatorUserId');
    }
    this.config = config;
    this.factory = options.clientFactory ?? defaultSlackClientFactory;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    if (this.clients !== undefined) throw new Error('SlackAdapter already started');
    const generation = ++this.generation;
    this.accepting = false;
    this.handlers = handlers;
    try {
      await withDeadline(this.startSequence(generation), this.startupTimeoutMs);
    } catch (error) {
      if (this.generation === generation) {
        this.generation += 1;
        this.accepting = false;
        await this.cleanupClients();
        this.handlers = undefined;
        this.identity = undefined;
      }
      throw startupError(error);
    }
  }

  async send(message: ChannelMessage): Promise<void> {
    const generation = this.generation;
    const run = this.sendTail.then(() => this.sendNow(message, generation));
    this.sendTail = run.catch(() => undefined);
    return run;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.generation += 1;
    await this.cleanupClients();
    await settleWithin(Promise.allSettled([this.dispatchTail, this.sendTail]), STOP_GRACE_MS);
    this.handlers = undefined;
    this.identity = undefined;
    this.recentKeys.clear();
    this.dispatchTail = Promise.resolve();
    this.sendTail = Promise.resolve();
    this.lastSendAt = 0;
  }

  private async startSequence(generation: number): Promise<void> {
    const clients = await startupStep('SDK initialization', () =>
      this.factory.create({ appToken: this.config.appToken, botToken: this.config.botToken }),
    );
    if (generation !== this.generation) {
      await settleWithin(Promise.allSettled([clients.socket.disconnect()]), STOP_GRACE_MS);
      this.requireGeneration(generation);
    }
    this.clients = clients;
    const { teamId, botUserId } = await startupStep('auth.test', async () => {
      const auth = asObject(await clients.web.auth.test());
      this.requireGeneration(generation);
      return {
        teamId: requireSlackString(auth, 'team_id', 'auth.test'),
        botUserId: requireSlackString(auth, 'user_id', 'auth.test'),
      };
    });
    const dmChannelId = await startupStep('conversations.open', async () => {
      const opened = asObject(await clients.web.conversations.open({ users: this.config.operatorUserId }));
      this.requireGeneration(generation);
      return requireSlackString(asObject(opened.channel), 'id', 'conversations.open');
    });
    this.identity = { teamId, botUserId, dmChannelId, operatorUserId: this.config.operatorUserId };
    clients.socket.on('slack_event', this.socketListener);
    await startupStep('Socket Mode connection', async () => {
      await clients.socket.start();
      this.requireGeneration(generation);
    });
    this.accepting = true;
    log().info('slack', 'Socket Mode operator channel connected');
  }

  private queueEnvelope(request: SlackSocketRequest, generation: number): void {
    // Start the transport acknowledgement immediately, but append its work to
    // the FIFO synchronously. Processing order therefore follows envelope
    // arrival order even if a future SDK resolves acknowledgements out of order.
    const acknowledged = this.acknowledge(request);
    this.dispatchTail = this.dispatchTail
      .then(async () => {
        if (!(await acknowledged)) return;
        if (!this.accepting || generation !== this.generation) return;
        const identity = this.identity;
        if (identity === undefined) return;
        const classified = classifySlackEnvelope(request, identity);
        if (classified === undefined || this.recentKeys.has(classified.dedupKey)) return;
        this.remember(classified.dedupKey);

        const handlers = this.handlers;
        if (handlers === undefined) return;
        const context = { conversationId: `${identity.teamId}:${identity.dmChannelId}` };
        const reply =
          classified.input.kind === 'command'
            ? await handlers.onCommand(classified.input.command, classified.input.args, context)
            : await handlers.onFreeText(classified.input.text, context);
        if (reply && this.accepting && generation === this.generation) await this.send({ text: reply });
      })
      .catch((error: unknown) => {
        log().error('slack', `Operator event handler failed (${safeErrorCode(error)})`);
      });
  }

  private acknowledge(request: SlackSocketRequest): Promise<boolean> {
    try {
      return request.ack({}).then(
        () => true,
        (error: unknown) => {
          log().warn('slack', `Envelope acknowledgement failed; awaiting replay (${safeErrorCode(error)})`);
          return false;
        },
      );
    } catch (error) {
      log().warn('slack', `Envelope acknowledgement failed; awaiting replay (${safeErrorCode(error)})`);
      return Promise.resolve(false);
    }
  }

  private async sendNow(message: ChannelMessage, generation: number): Promise<void> {
    this.requireGeneration(generation);
    if (this.clients === undefined || this.identity === undefined) throw new Error('SlackAdapter is not started');
    for (const payload of renderSlackPosts(message)) {
      this.requireGeneration(generation);
      const wait = Math.max(0, SEND_INTERVAL_MS - (this.now() - this.lastSendAt));
      if (wait > 0) await this.sleep(wait);
      this.requireGeneration(generation);
      await this.post(payload);
    }
  }

  private async post(payload: Omit<SlackPostMessage, 'channel'>): Promise<void> {
    const clients = this.clients;
    const identity = this.identity;
    if (clients === undefined || identity === undefined) throw new Error('SlackAdapter is not started');
    try {
      await clients.web.chat.postMessage({
        channel: identity.dmChannelId,
        unfurl_links: false,
        unfurl_media: false,
        ...payload,
      });
      this.lastSendAt = this.now();
    } catch (error) {
      const retryAfter = safeRetryAfter(error);
      const code = safeErrorCode(error);
      log().warn(
        'slack',
        `chat.postMessage failed (${code}${retryAfter === undefined ? '' : `; retry-after=${String(retryAfter)}s`})`,
      );
      throw Object.assign(new Error(`Slack chat.postMessage failed (${code})`), { code, retryAfter });
    }
  }

  private remember(key: string): void {
    this.recentKeys.add(key);
    if (this.recentKeys.size <= DEDUP_LIMIT) return;
    const oldest = this.recentKeys.values().next().value;
    if (oldest !== undefined) this.recentKeys.delete(oldest);
  }

  private requireGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw Object.assign(new Error('Slack operation was superseded'), { code: 'superseded' });
    }
  }

  private async cleanupClients(): Promise<void> {
    const clients = this.clients;
    this.clients = undefined;
    if (clients === undefined) return;
    clients.socket.off('slack_event', this.socketListener);
    try {
      const completed = await settleWithin(clients.socket.disconnect(), STOP_GRACE_MS);
      if (!completed) log().warn('slack', 'Socket cleanup exceeded its bounded grace period');
    } catch (error) {
      log().warn('slack', `Socket cleanup failed (${safeErrorCode(error)})`);
    }
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function requireSlackString(value: Record<string, unknown>, key: string, operation: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`Slack ${operation} returned no ${key}`);
  }
  return field;
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(Object.assign(new Error('Slack startup timed out'), { code: 'startup_timeout' }));
    }, milliseconds);
    timeout.unref();
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

const PERMANENT_CODES = new Set([
  'account_inactive',
  'access_denied',
  'app_disabled',
  'cannot_dm_bot',
  'invalid_auth',
  'invalid_app_token',
  'missing_scope',
  'not_authed',
  'not_allowed_token_type',
  'team_disabled',
  'token_revoked',
  'user_not_found',
  'user_removed_from_team',
  'users_not_found',
]);

class SlackStartupStepError extends Error {
  constructor(
    readonly step: string,
    readonly source: unknown,
  ) {
    super(`Slack startup failed during ${step}`);
    this.name = 'SlackStartupStepError';
  }
}

async function startupStep<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new SlackStartupStepError(step, error);
  }
}

function startupError(error: unknown): Error {
  const code = safeErrorCode(error);
  const source = error instanceof SlackStartupStepError ? error.source : error;
  if (code === 'slack_dependencies_missing' && source instanceof Error) return source;
  const step = error instanceof SlackStartupStepError ? ` during ${error.step}` : '';
  const qualification = PERMANENT_CODES.has(code) ? 'configuration must be fixed' : 'startup may be retried';
  return new Error(`Slack operator channel failed to start${step} (${code}; ${qualification}).`);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SlackStartupStepError) return safeErrorCode(error.source);
  if (typeof error !== 'object' || error === null) return 'unknown_error';
  const data = (error as { data?: { error?: unknown } }).data;
  if (typeof data?.error === 'string') return data.error;
  const direct = (error as { code?: unknown }).code;
  return typeof direct === 'string' ? direct : 'unknown_error';
}

function safeRetryAfter(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { retryAfter?: unknown }).retryAfter;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
  });
  const completed = await Promise.race([promise.then(() => true), expired.then(() => false)]);
  if (timeout !== undefined) clearTimeout(timeout);
  return completed;
}

export { classifySlackEnvelope, classifySlackText } from './classify.js';
export { escapeSlackText, renderSlackPosts } from './render.js';
export type { SlackClientFactory, SlackClients, SlackIdentity, SlackSocketClient, SlackWebClient } from './types.js';
