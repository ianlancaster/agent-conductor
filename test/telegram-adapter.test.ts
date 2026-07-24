import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelHandlers } from '../src/channels/types.js';
import { TelegramAdapter, type TelegramUpdate } from '../src/channels/telegram/index.js';
import { log } from '../src/logger.js';

const CHAT_ID = 777;

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Scriptable fetch double for the Telegram Bot API. */
class TelegramFetchMock {
  readonly calls: RecordedCall[] = [];
  private readonly updateBatches: TelegramUpdate[][] = [];
  readonly sendMessageResponses: { ok: boolean; error_code?: number; description?: string }[] = [];
  readonly getMeResponses: { ok: boolean; error_code?: number; description?: string }[] = [];
  readonly getUpdatesErrors: { error_code: number; description: string }[] = [];

  queueUpdates(batch: TelegramUpdate[]): void {
    this.updateBatches.push(batch);
  }

  callsFor(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = url.split('/').pop() ?? '';
    const payload = JSON.parse((init?.body as string | undefined) ?? '{}') as Record<string, unknown>;
    this.calls.push({ method, payload });

    if (method === 'getUpdates') {
      const error = this.getUpdatesErrors.shift();
      if (error !== undefined) return Promise.resolve(json({ ok: false, ...error }));
      const batch = this.updateBatches.shift();
      if (batch !== undefined) return Promise.resolve(json({ ok: true, result: batch }));
      // No scripted updates: hang like a real long-poll until aborted.
      return new Promise((_resolve, reject) => {
        const abort = (): void => {
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (init?.signal?.aborted === true) {
          abort();
          return;
        }
        init?.signal?.addEventListener('abort', abort);
      });
    }

    if (method === 'sendMessage') {
      const scripted = this.sendMessageResponses.shift();
      return Promise.resolve(json(scripted !== undefined ? { ...scripted, result: {} } : { ok: true, result: {} }));
    }

    if (method === 'getMe') {
      const scripted = this.getMeResponses.shift();
      return Promise.resolve(json(scripted !== undefined ? { ...scripted, result: {} } : { ok: true, result: {} }));
    }

    return Promise.resolve(json({ ok: true, result: true }));
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Generous budget: these assertions only wait for a mocked fetch call to be
// recorded, which is near-instant when the worker has CPU. The margin absorbs
// scheduler starvation when the whole suite (incl. the process-spawning tmux
// E2E) runs in parallel, so this can't flake on a busy machine.
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(): condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function commandUpdate(id: number, text: string, chatId = CHAT_ID): TelegramUpdate {
  return { update_id: id, message: { chat: { id: chatId }, text } };
}

function callbackUpdate(id: number, data: string, chatId = CHAT_ID): TelegramUpdate {
  return {
    update_id: id,
    callback_query: { id: `callback-${String(id)}`, data, message: { chat: { id: chatId } } },
  };
}

let mock: TelegramFetchMock;
let adapter: TelegramAdapter;
let handled: { kind: string; value: string }[];
let handlers: ChannelHandlers;

beforeEach(() => {
  mock = new TelegramFetchMock();
  vi.stubGlobal('fetch', mock.fetch);
  adapter = new TelegramAdapter({ botToken: 'test-token', chatId: String(CHAT_ID) });
  handled = [];
  handlers = {
    onCommand: async (command, args) => {
      handled.push({ kind: 'command', value: `${command} ${args.join(',')}`.trim() });
      return `did ${command}`;
    },
    onFreeText: async (text) => {
      handled.push({ kind: 'freeText', value: text });
      return undefined;
    },
  };
});

afterEach(async () => {
  await adapter.stop();
  vi.unstubAllGlobals();
});

describe('poll loop', () => {
  it('validates the bot token before starting the long poll', async () => {
    mock.getMeResponses.push({ ok: false, error_code: 404, description: 'Not Found' });

    await expect(adapter.start(handlers)).rejects.toThrow(/Telegram rejected the configured bot token/);
    expect(mock.callsFor('getUpdates')).toEqual([]);
  });

  it('does not write configured credential values to logs', async () => {
    const infoSpy = vi.spyOn(log(), 'info').mockImplementation(() => undefined);
    await adapter.start(handlers);
    await until(() => mock.callsFor('getUpdates').length === 1);
    expect(infoSpy.mock.calls.flat().join(' ')).not.toContain(String(CHAT_ID));
    expect(infoSpy.mock.calls.flat().join(' ')).not.toContain('test-token');
    infoSpy.mockRestore();
  });

  it('routes commands from the configured chat and sends the reply back', async () => {
    mock.queueUpdates([commandUpdate(10, '/status alpha')]);
    await adapter.start(handlers);
    await until(() => mock.callsFor('sendMessage').length > 0);

    expect(handled).toEqual([{ kind: 'command', value: 'status alpha' }]);
    expect(mock.callsFor('sendMessage')[0]?.payload.text).toBe('did status');
  });

  it('renders status and help for Telegram\u2019s bare /start handshake', async () => {
    mock.queueUpdates([commandUpdate(11, '/start')]);
    await adapter.start(handlers);
    await until(() => mock.callsFor('sendMessage').length > 0);

    expect(handled).toEqual([
      { kind: 'command', value: 'status' },
      { kind: 'command', value: 'help' },
    ]);
    expect(mock.callsFor('sendMessage')[0]?.payload.text).toBe('did status\n\ndid help');
  });

  it('preserves targeted /start as the canonical lifecycle command', async () => {
    mock.queueUpdates([commandUpdate(12, '/start alpha')]);
    await adapter.start(handlers);
    await until(() => mock.callsFor('sendMessage').length > 0);

    expect(handled).toEqual([{ kind: 'command', value: 'start alpha' }]);
    expect(mock.callsFor('sendMessage')[0]?.payload.text).toBe('did start');
  });

  it('advances the getUpdates offset past processed updates', async () => {
    mock.queueUpdates([commandUpdate(41, '/help')]);
    await adapter.start(handlers);
    await until(() => mock.callsFor('getUpdates').length >= 2);

    const offsets = mock.callsFor('getUpdates').map((call) => call.payload.offset);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(42);
  });

  it('ignores updates from other chats entirely', async () => {
    mock.queueUpdates([commandUpdate(1, '/stop all', 999), commandUpdate(2, 'hello', 999)]);
    mock.queueUpdates([commandUpdate(3, '/help')]);
    await adapter.start(handlers);
    await until(() => handled.length > 0);

    expect(handled).toEqual([{ kind: 'command', value: 'help' }]);
  });

  it('treats // as pass-through: strips one slash and routes as free text', async () => {
    mock.queueUpdates([commandUpdate(1, '//compact')]);
    await adapter.start(handlers);
    await until(() => handled.length > 0);

    expect(handled).toEqual([{ kind: 'freeText', value: '/compact' }]);
  });

  it('survives a throwing handler and keeps processing later updates', async () => {
    handlers.onCommand = async (command) => {
      if (command === 'boom') throw new Error('handler exploded');
      handled.push({ kind: 'command', value: command });
      return '';
    };
    mock.queueUpdates([commandUpdate(1, '/boom')]);
    mock.queueUpdates([commandUpdate(2, '/status')]);
    await adapter.start(handlers);
    await until(() => handled.length > 0);

    expect(handled).toEqual([{ kind: 'command', value: 'status' }]);
  });

  it('acknowledges an authorized callback before routing its canonical command', async () => {
    let acknowledgedBeforeHandler = false;
    handlers.onCommand = async (command, args, context) => {
      acknowledgedBeforeHandler = mock.callsFor('answerCallbackQuery').length === 1;
      handled.push({ kind: 'command', value: `${command} ${args.join(',')} ${context.conversationId}` });
      return 'recorded';
    };
    mock.queueUpdates([callbackUpdate(7, '/respond 42 2')]);
    await adapter.start(handlers);
    await until(() => mock.callsFor('sendMessage').length === 1);

    expect(acknowledgedBeforeHandler).toBe(true);
    expect(mock.callsFor('answerCallbackQuery')[0]?.payload).toEqual({ callback_query_id: 'callback-7' });
    expect(handled).toEqual([{ kind: 'command', value: `respond 42,2 ${String(CHAT_ID)}` }]);
    expect(mock.callsFor('sendMessage')[0]?.payload.text).toBe('recorded');
  });

  it('ignores and does not acknowledge callbacks from unauthorized chats', async () => {
    mock.queueUpdates([callbackUpdate(8, '/respond 42 1', 999)]);
    mock.queueUpdates([commandUpdate(9, '/help')]);
    await adapter.start(handlers);
    await until(() => handled.length === 1);

    expect(handled).toEqual([{ kind: 'command', value: 'help' }]);
    expect(mock.callsFor('answerCallbackQuery')).toEqual([]);
  });

  it('stops promptly while a long-poll is pending', async () => {
    await adapter.start(handlers);
    await until(() => mock.callsFor('getUpdates').length === 1);
    await adapter.stop(); // afterEach stops again — must be safe
    expect(mock.callsFor('getUpdates').length).toBe(1);
  });

  it('explains a 409 getUpdates conflict (another conductor on the same bot token)', async () => {
    const errorSpy = vi.spyOn(log(), 'error').mockImplementation(() => undefined);
    mock.getUpdatesErrors.push({ error_code: 409, description: 'terminated by other getUpdates request' });
    await adapter.start(handlers);
    await until(() =>
      errorSpy.mock.calls.some(([scope, message]) => scope === 'telegram' && message.includes('its own bot token')),
    );
    errorSpy.mockRestore();
  });
});

describe('send', () => {
  it('retries as plain text when Markdown parsing fails with a 400', async () => {
    mock.sendMessageResponses.push({ ok: false, error_code: 400, description: 'cannot parse entities' });
    await adapter.send({ text: '*unbalanced markdown' });

    const sends = mock.callsFor('sendMessage');
    expect(sends.length).toBe(2);
    expect(sends[0]?.payload.parse_mode).toBe('Markdown');
    expect(sends[1]?.payload.parse_mode).toBeUndefined();
    expect(sends[1]?.payload.text).toBe('*unbalanced markdown');
  });

  it('splits long messages into multiple sends', async () => {
    const long = `${'a'.repeat(5000)}\n\ntail section`;
    await adapter.send({ text: long });

    const sends = mock.callsFor('sendMessage');
    expect(sends.length).toBeGreaterThan(1);
    expect(sends[sends.length - 1]?.payload.text).toContain('tail section');
  });

  it('attaches action buttons only to the final chunk', async () => {
    await adapter.send({
      text: `${'a'.repeat(5000)}\n\ntail`,
      actions: [
        { label: 'Staging', command: '/respond 42 1' },
        { label: 'Production', command: '/respond 42 2' },
      ],
    });

    const sends = mock.callsFor('sendMessage');
    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]?.payload.reply_markup).toBeUndefined();
    expect(sends[sends.length - 1]?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Staging', callback_data: '/respond 42 1' },
          { text: 'Production', callback_data: '/respond 42 2' },
        ],
      ],
    });
  });

  it('preserves the inline keyboard when Markdown falls back to plain text', async () => {
    mock.sendMessageResponses.push({ ok: false, error_code: 400, description: 'cannot parse entities' });
    await adapter.send({ text: '*broken', actions: [{ label: 'Yes', command: '/respond 1 1' }] });

    const sends = mock.callsFor('sendMessage');
    expect(sends[1]?.payload.parse_mode).toBeUndefined();
    expect(sends[1]?.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Yes', callback_data: '/respond 1 1' }]],
    });
  });

  it('rejects callback data over Telegram’s 64-byte limit before sending', async () => {
    await expect(
      adapter.send({ text: 'choose', actions: [{ label: 'Too long', command: `/${'é'.repeat(32)}` }] }),
    ).rejects.toThrow(/64 UTF-8 bytes/);
    expect(mock.callsFor('sendMessage')).toEqual([]);
  });

  it('skips empty messages without calling the API', async () => {
    await adapter.send({ text: '   ' });
    expect(mock.callsFor('sendMessage')).toEqual([]);
  });
});
