import { describe, expect, it, vi } from 'vitest';

import {
  SlackAdapter,
  classifySlackEnvelope,
  classifySlackText,
  escapeSlackText,
  renderSlackPosts,
  type SlackClientFactory,
  type SlackClients,
  type SlackIdentity,
  type SlackSocketClient,
  type SlackWebClient,
} from '../src/channels/slack/index.js';
import type { ChannelHandlers } from '../src/channels/types.js';
import { splitMessage } from '../src/channels/split.js';

const identity: SlackIdentity = {
  teamId: 'T1',
  operatorUserId: 'U1',
  dmChannelId: 'D1',
  botUserId: 'UBOT',
};

describe('Slack input classification', () => {
  it.each([
    ['hello', { kind: 'freeText', text: 'hello' }],
    ['!!literal', { kind: 'freeText', text: '!literal' }],
    ['!send /compact', { kind: 'freeText', text: '/compact' }],
    ['!send', { kind: 'command', command: 'help', args: [] }],
    ['!', { kind: 'command', command: 'help', args: [] }],
    ['!   ', { kind: 'command', command: 'help', args: [] }],
    ['!status alpha', { kind: 'command', command: 'status', args: ['alpha'] }],
    ['!/talk alpha', { kind: 'command', command: 'talk', args: ['alpha'] }],
  ])('classifies %j', (text, expected) => {
    expect(classifySlackText(text)).toEqual(expected);
  });

  it('requires the authenticated team, user, DM, and IM channel type', () => {
    const base = messageRequest('e1', 'hello');
    expect(classifySlackEnvelope(base, identity)?.input).toEqual({ kind: 'freeText', text: 'hello' });
    for (const mutation of [
      { team_id: 'OTHER' },
      { event: { ...base.body.event, user: 'OTHER' } },
      { event: { ...base.body.event, channel: 'OTHER' } },
      { event: { ...base.body.event, channel_type: 'channel' } },
      { event: { ...base.body.event, subtype: 'message_changed' } },
      { event: { ...base.body.event, bot_id: 'B1' } },
      { event: { ...base.body.event, user: 'UBOT' } },
      { event: { ...base.body.event, text: '', files: [{ id: 'F1' }] } },
    ]) {
      expect(classifySlackEnvelope({ ...base, body: { ...base.body, ...mutation } }, identity)).toBeUndefined();
    }
  });

  it('ignores malformed payloads instead of throwing', () => {
    for (const body of [undefined, null, 1, 'bad', {}, { event: null }, { actions: 'bad' }]) {
      expect(classifySlackEnvelope({ type: 'events_api', envelope_id: 'e', body }, identity)).toBeUndefined();
      expect(classifySlackEnvelope({ type: 'interactive', envelope_id: 'e', body }, identity)).toBeUndefined();
    }
  });

  it('accepts only authenticated command-valued block actions', () => {
    const request = interactiveRequest('env-1', '/respond 8 2');
    expect(classifySlackEnvelope(request, identity)).toEqual({
      dedupKey: 'env-1',
      input: { kind: 'command', command: 'respond', args: ['8', '2'] },
    });
    expect(
      classifySlackEnvelope({ ...request, body: { ...request.body, user: { id: 'OTHER' } } }, identity),
    ).toBeUndefined();
    expect(
      classifySlackEnvelope(
        { ...request, body: { ...request.body, actions: [{ action_id: 'foreign_button', value: '/status' }] } },
        identity,
      ),
    ).toBeUndefined();
  });
});

describe('Slack rendering', () => {
  it('escapes Slack entities and mention syntax', () => {
    expect(escapeSlackText('& <@U1> <!channel> >')).toBe('&amp; &lt;@U1&gt; &lt;!channel&gt; &gt;');
  });

  it('chunks without splitting a Unicode surrogate pair', () => {
    const posts = renderSlackPosts({ text: `${'a'.repeat(2999)}😀tail` });
    expect(posts).toHaveLength(2);
    expect(posts.every((post) => post.text.length <= 3000)).toBe(true);
    expect(posts.map((post) => post.text).join('')).toBe(`${'a'.repeat(2999)}😀tail`);
  });

  it('fails clearly instead of looping when a limit cannot hold one Unicode code point', () => {
    expect(() => splitMessage('😀x', 1)).toThrow(/too small.*Unicode code point/);
  });

  it('puts accessible buttons only on the last chunk and validates Slack limits', () => {
    const posts = renderSlackPosts({
      text: 'a'.repeat(3001),
      actions: [{ label: 'Approve', command: '/respond 1 1' }],
    });
    expect(posts).toHaveLength(2);
    expect(posts[0]?.blocks).toBeUndefined();
    expect(posts[1]?.blocks?.[1]).toMatchObject({ type: 'actions' });
    expect(posts[1]?.text).toContain('1. Approve');
    expect(() => renderSlackPosts({ text: 'x', actions: [{ label: '', command: '/x' }] })).toThrow(/action label/);
    const longLabel = renderSlackPosts({ text: 'x', actions: [{ label: 'L'.repeat(80), command: '/x' }] });
    expect(
      ((longLabel[0]?.blocks?.[1] as { elements: { text: { text: string } }[] }).elements[0]?.text.text ?? '').length,
    ).toBe(75);
  });
});

describe('SlackAdapter scripted transport', () => {
  it('starts through auth, DM derivation, socket hello, and one safe greeting', async () => {
    const fake = makeClients();
    const adapter = makeAdapter(fake);
    await adapter.start(noopHandlers());

    expect(fake.socket.startCount).toBe(1);
    expect(fake.web.openCalls).toEqual([{ users: 'U1' }]);
    expect(fake.web.posts).toEqual([
      {
        channel: 'D1',
        text: 'Conductor connected to this private App Home conversation. Only the configured Slack operator can operate the configured fleet.',
        unfurl_links: false,
        unfurl_media: false,
      },
    ]);
    expect(JSON.stringify(fake.web.posts)).not.toContain('xapp-test');
    await adapter.stop();
    expect(fake.socket.disconnectCount).toBe(1);
  });

  it('acks before dispatch, preserves FIFO, and keeps handler failures isolated', async () => {
    const fake = makeClients();
    const adapter = makeAdapter(fake);
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await adapter.start({
      onCommand: async (command) => {
        order.push(`start:${command}`);
        if (command === 'talk') await first;
        order.push(`end:${command}`);
        if (command === 'fail') throw new Error('handler exploded');
        return '';
      },
      onFreeText: async (text) => {
        order.push(`text:${text}`);
        return undefined;
      },
    });

    const firstAck = vi.fn(async () => undefined);
    fake.socket.emit({ ...messageRequest('e1', '!talk alpha'), ack: firstAck });
    fake.socket.emit(messageRequest('e2', 'follow-up'));
    await until(() => firstAck.mock.calls.length === 1 && order.includes('start:talk'));
    expect(order).toEqual(['start:talk']);
    releaseFirst?.();
    await until(() => order.length === 3);
    expect(order).toEqual(['start:talk', 'end:talk', 'text:follow-up']);

    fake.socket.emit(messageRequest('e3', '!fail'));
    fake.socket.emit(messageRequest('e4', 'still-runs'));
    await until(() => order.includes('text:still-runs'));
    await adapter.stop();
  });

  it('preserves arrival order when a later acknowledgement resolves first', async () => {
    const fake = makeClients();
    const adapter = makeAdapter(fake);
    const order: string[] = [];
    let resolveFirstAck: (() => void) | undefined;
    const firstAck = new Promise<void>((resolve) => {
      resolveFirstAck = resolve;
    });
    await adapter.start({
      onCommand: async (command) => {
        order.push(`command:${command}`);
        return '';
      },
      onFreeText: async (text) => {
        order.push(`text:${text}`);
        return undefined;
      },
    });

    fake.socket.emit({ ...messageRequest('ack-first', '!talk alpha'), ack: async () => firstAck });
    const secondAck = vi.fn(async () => undefined);
    fake.socket.emit({ ...messageRequest('ack-second', 'follow-up'), ack: secondAck });
    await until(() => secondAck.mock.calls.length === 1);
    expect(order).toEqual([]);
    resolveFirstAck?.();
    await until(() => order.length === 2);
    expect(order).toEqual(['command:talk', 'text:follow-up']);
    await adapter.stop();
  });

  it('deduplicates only after a successful acknowledgement', async () => {
    const fake = makeClients();
    const handled: string[] = [];
    const adapter = makeAdapter(fake);
    await adapter.start({
      onCommand: async (command) => {
        handled.push(command);
        return '';
      },
      onFreeText: async (text) => {
        handled.push(text);
        return undefined;
      },
    });

    const failedAck = vi.fn(async () => {
      throw Object.assign(new Error('disconnected'), { code: 'send_failed' });
    });
    fake.socket.emit({ ...messageRequest('same-event', 'once'), ack: failedAck });
    await until(() => failedAck.mock.calls.length === 1);
    expect(handled).toEqual([]);

    fake.socket.emit(messageRequest('same-event', 'once'));
    fake.socket.emit(messageRequest('same-event', 'once'));
    fake.socket.emit(interactiveRequest('same-envelope', '/status'));
    fake.socket.emit(interactiveRequest('same-envelope', '/status'));
    await until(() => handled.length === 2);
    expect(handled).toEqual(['once', 'status']);
    await adapter.stop();
  });

  it('acknowledges unauthorized envelopes without dispatching or replying', async () => {
    const fake = makeClients();
    const handled = vi.fn(async () => undefined);
    const adapter = makeAdapter(fake);
    await adapter.start({ onCommand: async () => '', onFreeText: handled });
    fake.web.posts.length = 0;
    const request = messageRequest('unauthorized', 'secret');
    const ack = vi.fn(async () => undefined);
    fake.socket.emit({
      ...request,
      ack,
      body: { ...request.body, event: { ...request.body.event, user: 'OTHER' } },
    });
    await until(() => ack.mock.calls.length === 1);
    expect(handled).not.toHaveBeenCalled();
    expect(fake.web.posts).toEqual([]);
    await adapter.stop();
  });

  it.each(['invalid_auth', 'token_revoked', 'account_inactive', 'missing_scope', 'users_not_found'])(
    'classifies permanent startup failure %s without reflecting secrets',
    async (code) => {
      const fake = makeClients();
      fake.web.auth.test = async () => {
        throw Object.assign(new Error('invalid xoxb-super-secret'), {
          code: 'slack_webapi_platform_error',
          data: { error: code },
        });
      };
      const adapter = makeAdapter(fake);
      const failure = adapter.start(noopHandlers());
      await expect(failure).rejects.toThrow(new RegExp(`${code}.*configuration must be fixed`));
      await expect(failure).rejects.not.toThrow(/super-secret/);
      expect(fake.socket.disconnectCount).toBe(1);
    },
  );

  it('sanitizes a transient startup-greeting failure and reports retry guidance', async () => {
    const fake = makeClients();
    fake.web.chat.postMessage = async () => {
      throw Object.assign(new Error('operator text and xoxb-secret'), {
        code: 'slack_webapi_rate_limited_error',
        retryAfter: 2,
      });
    };
    const adapter = makeAdapter(fake);
    const failure = adapter.start(noopHandlers());
    await expect(failure).rejects.toThrow(/slack_webapi_rate_limited_error.*startup may be retried/);
    await expect(failure).rejects.not.toThrow(/operator text|xoxb-secret/);
  });

  it('identifies the startup step when a non-coded response is malformed', async () => {
    const fake = makeClients();
    fake.web.auth.test = async () => ({});
    const adapter = makeAdapter(fake);
    await expect(adapter.start(noopHandlers())).rejects.toThrow(/during auth\.test.*unknown_error/);
  });

  it('isolates reply-send failures and processes the next event', async () => {
    const fake = makeClients();
    const adapter = makeAdapter(fake);
    let calls = 0;
    await adapter.start({
      onCommand: async () => '',
      onFreeText: async (text) => `reply:${text}`,
    });
    fake.web.chat.postMessage = async (payload) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('payload secret'), { code: 'request_failed' });
      fake.web.posts.push(payload);
      return {};
    };
    fake.socket.emit(messageRequest('send-fails', 'first'));
    fake.socket.emit(messageRequest('send-recovers', 'second'));
    await until(() => fake.web.posts.some((post) => post.text === 'reply:second'));
    expect(fake.web.posts.some((post) => post.text === 'reply:first')).toBe(false);
    await adapter.stop();
  });

  it('can stop and restart without duplicate socket listeners', async () => {
    const fake = makeClients();
    const handled: string[] = [];
    const adapter = makeAdapter(fake);
    const handlers: ChannelHandlers = {
      onCommand: async () => '',
      onFreeText: async (text) => {
        handled.push(text);
        return undefined;
      },
    };
    await adapter.start(handlers);
    await adapter.stop();
    await adapter.stop();
    await adapter.start(handlers);
    fake.socket.emit(messageRequest('after-restart', 'once'));
    await until(() => handled.length === 1);
    expect(handled).toEqual(['once']);
    await adapter.stop();
  });

  it('does not let a superseded partial start clobber a later connection', async () => {
    const stale = makeClients();
    const current = makeClients();
    let resolveStale: ((clients: SlackClients) => void) | undefined;
    const staleClients = new Promise<SlackClients>((resolve) => {
      resolveStale = resolve;
    });
    let creates = 0;
    const adapter = new SlackAdapter(
      { appToken: 'xapp-test', botToken: 'xoxb-test', operatorUserId: 'U1' },
      {
        clientFactory: {
          create: async () => {
            creates += 1;
            return creates === 1 ? staleClients : current;
          },
        },
        startupTimeoutMs: 1_000,
        sleep: async () => undefined,
      },
    );
    const firstStart = expect(adapter.start(noopHandlers())).rejects.toThrow(/superseded/);
    await adapter.stop();
    await adapter.start(noopHandlers());
    resolveStale?.(stale);
    await firstStart;
    expect(current.socket.disconnectCount).toBe(0);
    expect(stale.socket.disconnectCount).toBe(1);
    await adapter.send({ text: 'still connected' });
    expect(current.web.posts.at(-1)?.text).toBe('still connected');
    await adapter.stop();
  });

  it('paces outbound chunks and attaches actions to the final post', async () => {
    const fake = makeClients();
    let now = 1_000;
    const sleeps: number[] = [];
    const adapter = new SlackAdapter(
      { appToken: 'xapp-test', botToken: 'xoxb-test', operatorUserId: 'U1' },
      {
        clientFactory: factory(fake),
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
      },
    );
    await adapter.start(noopHandlers());
    fake.web.posts.length = 0;
    await adapter.send({ text: 'x'.repeat(3001), actions: [{ label: 'Yes', command: '/respond 1 1' }] });
    expect(fake.web.posts).toHaveLength(2);
    expect(sleeps).toEqual([1000, 1000]);
    expect(fake.web.posts[0]?.blocks).toBeUndefined();
    expect(fake.web.posts[1]?.blocks).toBeDefined();
    await adapter.stop();
  });

  it('fails startup within its deadline and disconnects partial clients', async () => {
    vi.useFakeTimers();
    const fake = makeClients();
    fake.socket.start = async () => new Promise(() => undefined);
    const adapter = makeAdapter(fake, 45_000);
    const started = expect(adapter.start(noopHandlers())).rejects.toThrow(/startup_timeout.*startup may be retried/);
    await vi.advanceTimersByTimeAsync(45_000);
    await started;
    expect(fake.socket.disconnectCount).toBe(1);
    vi.useRealTimers();
  });
});

interface FakeSocket extends SlackSocketClient {
  startCount: number;
  disconnectCount: number;
  emit(request: ReturnType<typeof messageRequest> | ReturnType<typeof interactiveRequest>): void;
  start(): Promise<unknown>;
}

interface FakeWeb extends SlackWebClient {
  openCalls: { users: string }[];
  posts: Record<string, unknown>[];
}

function makeClients(): { socket: FakeSocket; web: FakeWeb } {
  let listener: ((request: Parameters<FakeSocket['emit']>[0]) => void) | undefined;
  const socket: FakeSocket = {
    startCount: 0,
    disconnectCount: 0,
    on: (_event, next) => {
      listener = next;
      return socket;
    },
    off: (_event, next) => {
      if (listener === next) listener = undefined;
      return socket;
    },
    start: async () => {
      socket.startCount += 1;
      return {};
    },
    disconnect: async () => {
      socket.disconnectCount += 1;
    },
    emit: (request) => listener?.(request),
  };
  const web: FakeWeb = {
    openCalls: [],
    posts: [],
    auth: { test: async () => ({ team_id: 'T1', user_id: 'UBOT' }) },
    conversations: {
      open: async (args) => {
        web.openCalls.push(args);
        return { channel: { id: 'D1' } };
      },
    },
    chat: {
      postMessage: async (args) => {
        web.posts.push(args);
        return { ok: true };
      },
    },
  };
  return { socket, web };
}

function factory(clients: SlackClients): SlackClientFactory {
  return { create: async () => clients };
}

function makeAdapter(clients: SlackClients, startupTimeoutMs = 1_000): SlackAdapter {
  return new SlackAdapter(
    { appToken: 'xapp-test', botToken: 'xoxb-test', operatorUserId: 'U1' },
    { clientFactory: factory(clients), startupTimeoutMs, sleep: async () => undefined },
  );
}

function noopHandlers(): ChannelHandlers {
  return {
    onCommand: async () => '',
    onFreeText: async () => undefined,
  };
}

function messageRequest(eventId: string, text: string) {
  return {
    type: 'events_api',
    envelope_id: `env-${eventId}`,
    ack: async () => undefined,
    body: {
      team_id: 'T1',
      event_id: eventId,
      event: { type: 'message', user: 'U1', channel: 'D1', channel_type: 'im', text },
    },
  } as const;
}

function interactiveRequest(envelopeId: string, value: string) {
  return {
    type: 'interactive',
    envelope_id: envelopeId,
    ack: async () => undefined,
    body: {
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U1' },
      channel: { id: 'D1' },
      actions: [{ action_id: 'conductor_action_0', value }],
    },
  } as const;
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
