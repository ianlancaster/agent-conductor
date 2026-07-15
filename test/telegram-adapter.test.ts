import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelHandlers } from '../src/channels/types.js';
import { TelegramAdapter, type TelegramUpdate } from '../src/channels/telegram/index.js';

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
    onCallback: async (data) => {
      handled.push({ kind: 'callback', value: data });
      return 'callback handled';
    },
  };
});

afterEach(async () => {
  await adapter.stop();
  vi.unstubAllGlobals();
});

describe('poll loop', () => {
  it('routes commands from the configured chat and sends the reply back', async () => {
    mock.queueUpdates([commandUpdate(10, '/status alpha')]);
    await adapter.start(handlers);
    await until(() => mock.callsFor('sendMessage').length > 0);

    expect(handled).toEqual([{ kind: 'command', value: 'status alpha' }]);
    expect(mock.callsFor('sendMessage')[0]?.payload.text).toBe('did status');
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

  it('answers callback queries and delivers the reply', async () => {
    mock.queueUpdates([
      { update_id: 5, callback_query: { id: 'cb-1', data: 'hi:3:0', message: { chat: { id: CHAT_ID } } } },
    ]);
    await adapter.start(handlers);
    await until(() => mock.callsFor('answerCallbackQuery').length > 0);

    expect(handled).toEqual([{ kind: 'callback', value: 'hi:3:0' }]);
    expect(mock.callsFor('answerCallbackQuery')[0]?.payload.callback_query_id).toBe('cb-1');
    await until(() => mock.callsFor('sendMessage').length > 0);
    expect(mock.callsFor('sendMessage')[0]?.payload.text).toBe('callback handled');
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

  it('stops promptly while a long-poll is pending', async () => {
    await adapter.start(handlers);
    await until(() => mock.callsFor('getUpdates').length === 1);
    await adapter.stop(); // afterEach stops again — must be safe
    expect(mock.callsFor('getUpdates').length).toBe(1);
  });
});

describe('send', () => {
  it('retries as plain text when Markdown parsing fails with a 400', async () => {
    mock.sendMessageResponses.push({ ok: false, error_code: 400, description: 'cannot parse entities' });
    await adapter.send('*unbalanced markdown');

    const sends = mock.callsFor('sendMessage');
    expect(sends.length).toBe(2);
    expect(sends[0]?.payload.parse_mode).toBe('Markdown');
    expect(sends[1]?.payload.parse_mode).toBeUndefined();
    expect(sends[1]?.payload.text).toBe('*unbalanced markdown');
  });

  it('splits long messages and attaches buttons to the LAST chunk only', async () => {
    const long = `${'a'.repeat(5000)}\n\ntail section`;
    await adapter.send(long, { buttons: [[{ label: 'Approve', data: 'ok:1' }]] });

    const sends = mock.callsFor('sendMessage');
    expect(sends.length).toBeGreaterThan(1);
    expect(sends.slice(0, -1).every((call) => call.payload.reply_markup === undefined)).toBe(true);
    const last = sends[sends.length - 1]?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(last.inline_keyboard[0]?.[0]).toEqual({ text: 'Approve', callback_data: 'ok:1' });
  });

  it('skips empty messages without calling the API', async () => {
    await adapter.send('   ');
    expect(mock.callsFor('sendMessage')).toEqual([]);
  });
});
