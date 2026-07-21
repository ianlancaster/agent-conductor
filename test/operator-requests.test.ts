import { describe, expect, it } from 'vitest';

import type { ChannelMessage } from '../src/channels/types.js';
import { OperatorRequests } from '../src/core/operator-requests.js';
import { Store } from '../src/store/index.js';

function setup(options: { delivered?: boolean; delivery?: () => Promise<string> } = {}): {
  store: Store;
  requests: OperatorRequests;
  outbound: ChannelMessage[];
  sessionMessages: { from: string; target: string; message: string }[];
} {
  const store = new Store(':memory:');
  const outbound: ChannelMessage[] = [];
  const sessionMessages: { from: string; target: string; message: string }[] = [];
  const requests = new OperatorRequests({
    store,
    channelSend: async (message) => {
      outbound.push(message);
      return options.delivered ?? true;
    },
    messaging: {
      sendToSession: async (from, target, message) => {
        sessionMessages.push({ from, target, message });
        return options.delivery === undefined ? 'Delivered to alpha.' : options.delivery();
      },
    },
  });
  return { store, requests, outbound, sessionMessages };
}

describe('OperatorRequests', () => {
  it('keeps plain operator messages backward compatible and unpersisted', async () => {
    const { store, requests, outbound } = setup();
    expect(await requests.send('alpha', 'heads up')).toBe('Sent to the operator.');
    expect(outbound).toEqual([{ text: '[Message from alpha] heads up' }]);
    expect(store.getOperatorRequest(1)).toBeUndefined();
    store.close();
  });

  it('persists a selectable request and emits channel-neutral actions', async () => {
    const { store, requests, outbound } = setup();
    expect(await requests.send('alpha', 'Deploy where?', [' Staging ', 'Production'])).toBe(
      'Request #1 sent to the operator.',
    );
    expect(store.getOperatorRequest(1)).toMatchObject({
      session: 'alpha',
      message: 'Deploy where?',
      options: ['Staging', 'Production'],
      status: 'pending',
    });
    expect(outbound[0]).toEqual({
      text: '[Message from alpha] Deploy where?',
      actions: [
        { label: 'Staging', command: '/respond 1 1' },
        { label: 'Production', command: '/respond 1 2' },
      ],
    });
    store.close();
  });

  it('delivers the selected choice to the original session with operator identity and context', async () => {
    const { store, requests, sessionMessages } = setup();
    await requests.send('alpha', 'Deploy where?', ['Staging', 'Production']);
    expect(await requests.respond(1, 2)).toBe('Delivered to alpha. Response recorded: Production');
    expect(sessionMessages).toEqual([
      {
        from: 'operator',
        target: 'alpha',
        message: 'Response to request #1 ("Deploy where?"): Production',
      },
    ]);
    expect(store.getOperatorRequest(1)).toMatchObject({ status: 'responded', selectedIndex: 1 });
    expect(await requests.respond(1, 1)).toBe('Operator request #1 was already answered: Production');
    store.close();
  });

  it('rejects unknown requests, invalid options, duplicate choices, and out-of-range responses', async () => {
    const { store, requests } = setup();
    expect(await requests.respond(99, 1)).toBe('Unknown operator request: #99.');
    await expect(requests.send('alpha', 'Choose', [])).rejects.toThrow(/between 1 and 8/);
    await expect(requests.send('alpha', 'Choose', ['same', ' same '])).rejects.toThrow(/unique/);
    await expect(requests.send('alpha', 'Choose', ['x'.repeat(81)])).rejects.toThrow(/at most 80/);
    await requests.send('alpha', 'Choose', ['one', 'two']);
    expect(await requests.respond(1, 3)).toContain('choose 1–2');
    store.close();
  });

  it('allows only one concurrent response to claim a request', async () => {
    let releaseDelivery: (() => void) | undefined;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const { store, requests, sessionMessages } = setup({
      delivery: async () => {
        await deliveryGate;
        return 'Delivered to alpha.';
      },
    });
    await requests.send('alpha', 'Choose', ['one', 'two']);

    const first = requests.respond(1, 1);
    const second = await requests.respond(1, 2);
    expect(second).toBe('Operator request #1 is already being answered.');
    releaseDelivery?.();
    await expect(first).resolves.toContain('Response recorded: one');
    expect(sessionMessages).toHaveLength(1);
    store.close();
  });

  it('releases a claim when session delivery throws so it can be retried', async () => {
    let attempts = 0;
    const { store, requests } = setup({
      delivery: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('pane write failed')) : Promise.resolve('Delivered to alpha.');
      },
    });
    await requests.send('alpha', 'Choose', ['one']);
    await expect(requests.respond(1, 1)).rejects.toThrow('pane write failed');
    expect(store.getOperatorRequest(1)?.status).toBe('pending');
    await expect(requests.respond(1, 1)).resolves.toContain('Response recorded: one');
    store.close();
  });

  it('honestly reports no connected operator while preserving the pending request', async () => {
    const { store, requests } = setup({ delivered: false });
    expect(await requests.send('alpha', 'Choose', ['one'])).toMatch(/^NOT delivered:/);
    expect(store.getOperatorRequest(1)?.status).toBe('pending');
    store.close();
  });

  it('resets stale responding claims during explicit startup recovery', () => {
    const store = new Store(':memory:');
    const id = store.insertOperatorRequest('alpha', 'Choose', ['one']);
    store.claimOperatorRequest(id);
    const requests = new OperatorRequests({
      store,
      channelSend: async () => true,
      messaging: { sendToSession: async () => 'Delivered.' },
    });
    expect(requests.recoverStaleClaims()).toBe(1);
    expect(store.getOperatorRequest(id)?.status).toBe('pending');
    store.close();
  });
});
