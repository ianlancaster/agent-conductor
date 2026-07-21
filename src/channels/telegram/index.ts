import { setTimeout as delay } from 'node:timers/promises';

import { log } from '../../logger.js';
import type { ChannelAdapter, ChannelHandlers, ChannelMessage } from '../types.js';
import { renderChannelMessage } from '../render.js';
import { splitMessage } from './split.js';

const POLL_TIMEOUT_SECONDS = 30;
const ERROR_BACKOFF_MS = 5000;
/** Ceiling for a single sendMessage round-trip so a half-open socket can't freeze the poll loop. */
const SEND_TIMEOUT_MS = 15_000;
const CALLBACK_DATA_MAX_BYTES = 64;
const SHORT_BUTTON_LABEL_LENGTH = 30;

// ── Minimal Telegram Bot API payload shapes (only the fields we touch) ───────

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  chat: TelegramChat;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

class TelegramApiError extends Error {
  constructor(
    method: string,
    readonly status: number,
    description: string,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

// ── Pure update classification ───────────────────────────────────────────────

export type ClassifiedUpdate =
  { kind: 'command'; command: string; args: string[] } | { kind: 'freeText'; text: string };

function classifyText(text: string): ClassifiedUpdate {
  if (text.startsWith('//')) {
    return { kind: 'freeText', text: text.slice(1) };
  }

  if (text.startsWith('/')) {
    const parts = text.split(/\s+/).filter((part) => part.length > 0);
    const command = (parts[0] ?? '/').slice(1);
    return { kind: 'command', command, args: parts.slice(1) };
  }

  return { kind: 'freeText', text };
}

/**
 * Classify an incoming Telegram update for routing:
 *
 * - Text starting with `//` is the operator pass-through escape: strip ONE
 *   slash and deliver as free text (lets the operator send session-level slash
 *   commands without the bot intercepting them).
 * - Text starting with `/` → command; split on whitespace, leading slash
 *   removed from the command name.
 * - Any other text → free text.
 *
 * Returns undefined for updates that carry nothing routable (e.g. photo-only
 * messages).
 */
export function classifyUpdate(update: TelegramUpdate): ClassifiedUpdate | undefined {
  const callbackData = update.callback_query?.data;
  if (callbackData !== undefined) {
    const classified = classifyText(callbackData);
    return classified.kind === 'command' ? classified : undefined;
  }

  const text = update.message?.text;
  if (text === undefined) return undefined;
  return classifyText(text);
}

interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

/** Build compact keyboard rows while leaving long labels readable. */
export function buildInlineKeyboard(message: ChannelMessage): TelegramInlineButton[][] | undefined {
  const actions = message.actions;
  if (actions === undefined || actions.length === 0) return undefined;

  const buttons = actions.map((action) => {
    const bytes = Buffer.byteLength(action.command, 'utf8');
    if (bytes < 1 || bytes > CALLBACK_DATA_MAX_BYTES) {
      throw new Error(`Telegram action command must be between 1 and ${String(CALLBACK_DATA_MAX_BYTES)} UTF-8 bytes`);
    }
    return { text: action.label, callback_data: action.command };
  });
  const rows: TelegramInlineButton[][] = [];
  for (let index = 0; index < buttons.length;) {
    const current = buttons[index];
    const next = buttons[index + 1];
    if (
      current !== undefined &&
      next !== undefined &&
      current.text.length <= SHORT_BUTTON_LABEL_LENGTH &&
      next.text.length <= SHORT_BUTTON_LABEL_LENGTH
    ) {
      rows.push([current, next]);
      index += 2;
    } else if (current !== undefined) {
      rows.push([current]);
      index += 1;
    }
  }
  return rows;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface TelegramAdapterConfig {
  botToken: string;
  chatId: string;
}

/**
 * Telegram implementation of ChannelAdapter. Long-polls the Bot API directly
 * with fetch — no client library dependency.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';

  private readonly botToken: string;
  private readonly chatId: string;
  private handlers: ChannelHandlers | undefined;
  private abortController: AbortController | undefined;
  private pollPromise: Promise<void> | undefined;
  private polling = false;
  private offset = 0;

  constructor(config: TelegramAdapterConfig) {
    if (!config.botToken || !config.chatId) {
      throw new Error('TelegramAdapter requires botToken and chatId');
    }
    this.botToken = config.botToken;
    this.chatId = config.chatId;
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    if (this.pollPromise) throw new Error('TelegramAdapter already started');
    this.handlers = handlers;
    this.polling = true;
    this.abortController = new AbortController();
    this.pollPromise = this.pollLoop();
    log().info('telegram', 'Long-poll loop started');
  }

  async send(message: ChannelMessage): Promise<void> {
    const text = renderChannelMessage(message);
    if (!text.trim()) return;

    const chunks = splitMessage(text);
    const inlineKeyboard = buildInlineKeyboard(message);
    for (const [index, chunk] of chunks.entries()) {
      const payload: Record<string, unknown> = {
        chat_id: this.chatId,
        text: chunk,
        parse_mode: 'Markdown',
        ...(inlineKeyboard !== undefined && index === chunks.length - 1
          ? { reply_markup: { inline_keyboard: inlineKeyboard } }
          : {}),
      };

      try {
        await this.api('sendMessage', payload);
      } catch (err) {
        // Markdown parse failures are common (session output is not valid
        // Telegram Markdown) and surface as HTTP 400 — retry as plain text.
        if (!(err instanceof TelegramApiError) || err.status !== 400) {
          log().error('telegram', `sendMessage failed: ${String(err).slice(0, 200)}`);
          throw err;
        }
        log().warn('telegram', `Markdown send failed, retrying as plain text: ${String(err).slice(0, 200)}`);
        const plain = { ...payload };
        delete plain.parse_mode;
        try {
          await this.api('sendMessage', plain);
        } catch (err2) {
          log().error('telegram', `Plain-text send also failed: ${String(err2).slice(0, 200)}`);
          throw err2;
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.abortController?.abort();
    if (this.pollPromise) {
      await this.pollPromise;
      this.pollPromise = undefined;
    }
    this.abortController = undefined;
    this.handlers = undefined;
    log().info('telegram', 'Long-poll loop stopped');
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const updates = await this.api<TelegramUpdate[]>(
          'getUpdates',
          { timeout: POLL_TIMEOUT_SECONDS, offset: this.offset },
          this.abortController?.signal,
        );
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.polling) return;
        if (err instanceof TelegramApiError && err.status === 409) {
          // Telegram allows exactly one getUpdates poller per bot token. A 409
          // here means another process (most likely a second conductor) is
          // polling the same token. Keep retrying so we take over if it stops.
          log().error(
            'telegram',
            'Another process is polling this bot token (Telegram 409). ' +
              'Each conductor needs its own bot token — set a different CONDUCTOR_TELEGRAM_TOKEN ' +
              'for this fleet, or disable telegram in its config/supervisor.yaml.',
          );
        } else {
          log().warn('telegram', `getUpdates failed, backing off ${ERROR_BACKOFF_MS}ms: ${String(err).slice(0, 200)}`);
        }
        await this.backoff();
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const handlers = this.handlers;
    if (!handlers) return;

    const chatId = update.callback_query ? update.callback_query.message?.chat.id : update.message?.chat.id;
    if (chatId === undefined || String(chatId) !== this.chatId) return;

    const callback = update.callback_query;
    if (callback !== undefined) {
      try {
        await this.api('answerCallbackQuery', { callback_query_id: callback.id });
      } catch (err) {
        // Acknowledgement is best-effort: still process the operator's answer
        // if Telegram briefly fails this cosmetic progress-indicator request.
        log().warn('telegram', `answerCallbackQuery failed: ${String(err).slice(0, 200)}`);
      }
    }

    const classified = classifyUpdate(update);
    if (!classified) return;
    const context = { conversationId: String(chatId) };

    // Handler and reply-delivery errors are logged, never thrown: one bad
    // update must not kill the poll loop or trigger backoff.
    try {
      switch (classified.kind) {
        case 'command': {
          const reply = await handlers.onCommand(classified.command, classified.args, context);
          if (reply) {
            log().debug('telegram', `Responding to /${classified.command} (${reply.length} chars)`);
            await this.send({ text: reply });
          }
          break;
        }
        case 'freeText': {
          const reply = await handlers.onFreeText(classified.text, context);
          if (reply) await this.send({ text: reply });
          break;
        }
      }
    } catch (err) {
      log().error('telegram', `Update handler threw: ${String(err).slice(0, 200)}`);
    }
  }

  private async backoff(): Promise<void> {
    try {
      await delay(ERROR_BACKOFF_MS, undefined, { signal: this.abortController?.signal });
    } catch {
      // Aborted during backoff — the loop condition handles shutdown.
    }
  }

  // ── Bot API transport ──────────────────────────────────────────────────────

  private async api<T = unknown>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    // Every call gets a hard timeout; long-poll getUpdates also honors the
    // shutdown signal. Without this a half-open TCP (laptop sleep) would block
    // the single poll loop for undici's ~300s default.
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? (POLL_TIMEOUT_SECONDS + 10) * 1000 : SEND_TIMEOUT_MS);
    const combined = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: combined,
    });
    const body = (await res.json()) as TelegramApiResponse<T>;
    if (!body.ok || body.result === undefined) {
      throw new TelegramApiError(method, body.error_code ?? res.status, body.description ?? `HTTP ${res.status}`);
    }
    return body.result;
  }
}
