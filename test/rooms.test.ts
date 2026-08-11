import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelMessage } from '../src/channels/types.js';
import type { SessionConfig } from '../src/config/schema.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { InvalidRequestError } from '../src/core/errors.js';
import { Rooms, type RoomCaller, type RoomFederation } from '../src/core/rooms.js';
import { SessionStateManager } from '../src/core/state.js';
import type { PaneRef } from '../src/core/types.js';
import { Store } from '../src/store/index.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

interface PeerCall {
  fleet: string;
  operation: string;
  args: Record<string, unknown>;
  origin: { session: string; kind: 'session' | 'operator' };
}

let store: Store;
let states: SessionStateManager;
let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let delivery: DeliveryQueue;
let events: FakeEventPublisher;
let sessions: Map<string, SessionConfig>;
let panes: Map<string, PaneRef>;
let operatorMessages: ChannelMessage[];
let exposed: Set<string> | undefined;
let federation: RoomFederation | undefined;
let peerCalls: PeerCall[];
let peerRooms: { fleet: string; room: string; members: string[] }[];
let peerFailures: Map<string, string>;

const OPERATOR: RoomCaller = { name: 'operator', localOperator: true };

function session(codename: string): RoomCaller {
  return { name: codename, localSession: codename, localOperator: false };
}

function peer(codename: string, fleet: string, kind: 'session' | 'operator' = 'session'): RoomCaller {
  return { name: `${codename}@${fleet}`, localOperator: false, remote: { fleet, kind } };
}

function rooms(): Rooms {
  return new Rooms({
    store,
    delivery,
    states,
    sessions: () => sessions,
    channelSend: async (message) => {
      operatorMessages.push(message);
      return true;
    },
    ...(exposed === undefined ? {} : { exposedSessions: () => exposed as ReadonlySet<string> }),
    events,
    federation: () => federation,
  });
}

function register(codename: string): void {
  sessions.set(codename, { codename, repo: `/tmp/${codename}`, runtime: 'fake', additionalDirs: [], schedules: [] });
  states.register(codename, false);
}

async function start(codename: string): Promise<void> {
  const pane = await backend.createPane(codename, 'pane');
  panes.set(codename, pane);
  states.setSession(codename, pane.id);
}

function received(codename: string): string[] {
  const pane = panes.get(codename);
  return pane === undefined ? [] : (backend.panes.get(pane.id)?.received ?? []);
}

function enableFederation(): void {
  federation = {
    localFleet: 'frontend',
    refresh: async () => undefined,
    peerRooms: () => peerRooms,
    invokeOnPeer: async (fleet, operation, args, origin) => {
      peerCalls.push({ fleet, operation, args, origin });
      const failure = peerFailures.get(fleet);
      if (failure !== undefined) throw new Error(failure);
      return 'ok';
    },
  };
}

beforeEach(async () => {
  store = new Store(':memory:');
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  states = new SessionStateManager(store, false);
  events = new FakeEventPublisher();
  sessions = new Map();
  panes = new Map();
  operatorMessages = [];
  exposed = undefined;
  federation = undefined;
  peerCalls = [];
  peerRooms = [];
  peerFailures = new Map();
  delivery = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (codename) => panes.get(codename),
    config: { queueDrainMs: 2000 },
  });
  register('alpha');
  register('beta');
  register('gamma');
  await start('alpha');
  await start('beta');
});

afterEach(() => {
  delivery.stop();
  store.close();
});

describe('room lifecycle', () => {
  it('creates a room with members and notifies each of them exactly once', async () => {
    const result = await rooms().create('design-review', ['alpha', 'beta'], OPERATOR);

    expect(result).toBe('Room design-review created with members: alpha, beta.');
    expect(store.getRoomMembers('design-review').map((member) => member.member)).toEqual(['alpha', 'beta']);
    expect(received('alpha')).toEqual([
      '[Room: design-review] You were added by operator. Members: alpha, beta. ' +
        'Use send_to_room to speak to everyone in this room. No action required — this notice is informational.',
    ]);
    expect(received('beta')).toHaveLength(1);
  });

  it('states in the notice itself that a membership change needs no action', async () => {
    await rooms().create('design-review', ['alpha'], OPERATOR);
    await rooms().leave('design-review', 'alpha', OPERATOR);

    expect(received('alpha').at(-1)).toBe(
      '[Room: design-review] You were removed by operator. No action required — this notice is informational.',
    );
  });

  it('treats creating an existing room as convening it again rather than an error', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);

    expect(await module.create('design-review', ['alpha', 'beta'], OPERATOR)).toBe(
      'Room design-review already exists; added members: beta.',
    );
    expect(store.getRoomMembers('design-review')).toHaveLength(2);
  });

  it('rejects an invalid room name and an unregistered member', async () => {
    await expect(rooms().create('Design Review', undefined, OPERATOR)).rejects.toThrow(InvalidRequestError);
    await expect(rooms().create('design-review', ['nobody'], OPERATOR)).rejects.toThrow('Unknown session: nobody');
  });

  it('refuses to use a room that was never created, so a typo cannot swallow a conversation', async () => {
    const module = rooms();
    await expect(module.say('desgin-review', 'hello', OPERATOR)).rejects.toThrow(/Unknown room: desgin-review/);
    await expect(module.join('desgin-review', 'alpha', OPERATOR)).rejects.toThrow(/Unknown room/);
    await expect(module.leave('desgin-review', 'alpha', OPERATOR)).rejects.toThrow(/Unknown room/);
    await expect(module.close('desgin-review', OPERATOR)).rejects.toThrow(/Unknown room/);
  });

  it('closes a room, notifies its members, and deletes the membership', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha', 'beta'], OPERATOR);

    expect(await module.close('design-review', OPERATOR)).toBe('Room design-review closed; notified 2 member(s).');
    expect(store.getRoom('design-review')).toBeUndefined();
    expect(store.getRoomMembers('design-review')).toEqual([]);
    expect(received('alpha').at(-1)).toBe(
      '[Room: design-review] Room closed by operator. No action required — this notice is informational.',
    );
  });

  it('drops a deregistered session from every room it belonged to', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);
    await module.create('planning', ['alpha', 'beta'], OPERATOR);

    module.removeSession('alpha');

    expect(store.getRoomMembers('design-review')).toEqual([]);
    expect(store.getRoomMembers('planning').map((member) => member.member)).toEqual(['beta']);
    expect(events.events.filter((event) => event.type === 'room.membership.changed')).toContainEqual({
      type: 'room.membership.changed',
      room: 'planning',
      member: 'alpha',
      kind: 'session',
      change: 'left',
      by: 'conductor',
    });
  });
});

describe('room membership', () => {
  it('lets a session join itself and add a peer, notifying only the added peer', async () => {
    const module = rooms();
    await module.create('design-review', undefined, OPERATOR);

    expect(await module.join('design-review', undefined, session('alpha'))).toBe('alpha joined room design-review.');
    expect(await module.join('design-review', 'beta', session('alpha'))).toBe('beta joined room design-review.');

    expect(received('alpha')).toEqual([]);
    expect(received('beta')).toHaveLength(1);
  });

  it('reports an unchanged membership instead of duplicating a member', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);

    expect(await module.join('design-review', 'alpha', OPERATOR)).toBe('alpha is already in room design-review.');
    expect(await module.leave('design-review', 'beta', OPERATOR)).toBe('beta is not in room design-review.');
  });

  it('keeps the operator distinct from a session that happens to be called operator', async () => {
    register('operator');
    await start('operator');
    const module = rooms();
    await module.create('design-review', ['operator'], OPERATOR);
    await module.join('design-review', undefined, OPERATOR);

    expect(store.getRoomMembers('design-review')).toEqual([
      expect.objectContaining({ kind: 'operator', member: 'operator' }),
      expect.objectContaining({ kind: 'session', member: 'operator' }),
    ]);
  });
});

describe('room fan-out', () => {
  it('delivers to every member except the sender', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha', 'beta'], OPERATOR);

    expect(await module.say('design-review', 'settle the API boundary', session('alpha'))).toBe(
      'Room design-review: delivered to 1 member(s).',
    );
    expect(received('beta').at(-1)).toBe('[Room: design-review from alpha] settle the API boundary');
    expect(received('alpha')).toHaveLength(1); // the join notice only
  });

  it('skips members that are not running rather than starting them', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha', 'gamma'], OPERATOR);

    expect(await module.say('design-review', 'hello', OPERATOR)).toBe(
      'Room design-review: delivered to 1 member(s); skipped gamma (not running).',
    );
    expect(states.get('gamma')?.running).toBe(false);
    expect(panes.has('gamma')).toBe(false);
  });

  it('reaches the operator through the channel fan-out without echoing to the sender', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);
    await module.join('design-review', undefined, OPERATOR);

    await module.say('design-review', 'from a session', session('alpha'));
    expect(operatorMessages.at(-1)).toEqual({ text: '[Room: design-review from alpha] from a session' });

    operatorMessages = [];
    await module.say('design-review', 'from the operator', OPERATOR);
    expect(operatorMessages).toEqual([]);
    expect(received('alpha').at(-1)).toBe('[Room: design-review from operator] from the operator');
  });

  it('records one content-bearing ledger row per utterance and keeps it out of direct-message history', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha', 'beta'], OPERATOR);
    await module.say('design-review', 'hello room', session('alpha'));

    expect(store.getRecentMessageActivity('alpha')).toEqual([]);
    expect(events.events.at(-1)).toEqual({
      type: 'room.message',
      room: 'design-review',
      sender: 'alpha',
      recipientCount: 1,
      byteCount: 10,
    });
  });
});

describe('federated rooms', () => {
  beforeEach(() => {
    enableFederation();
    exposed = new Set(['alpha', 'beta']);
    peerRooms = [{ fleet: 'backend', room: 'design-review', members: ['api'] }];
  });

  it('calls each participating peer fleet directly, once, with the caller identity', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);

    expect(await module.say('design-review', 'confirm the contract', session('alpha'))).toBe(
      'Room design-review: delivered to 0 member(s). Routed to 1 peer fleet(s): backend.',
    );
    expect(peerCalls).toEqual([
      {
        fleet: 'backend',
        operation: 'send_to_room',
        args: { message: 'confirm the contract', room: 'design-review' },
        origin: { session: 'alpha', kind: 'session' },
      },
    ]);
  });

  it('carries an explicit operator origin so an operator can facilitate across fleets', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);
    await module.say('design-review', 'both sides please confirm', OPERATOR);

    expect(peerCalls.at(-1)?.origin).toEqual({ session: 'operator', kind: 'operator' });
  });

  it('never relays a peer-originated message onward to a third fleet', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);

    expect(await module.say('design-review', 'from the api', peer('api', 'backend'))).toBe(
      'Room design-review: delivered to 1 member(s).',
    );
    expect(peerCalls).toEqual([]);
    expect(received('alpha').at(-1)).toBe('[Room: design-review from api@backend] from the api');
  });

  it('never relays a peer-originated close onward either', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);

    await module.close('design-review', peer('api', 'backend'));
    expect(peerCalls).toEqual([]);
    expect(store.getRoom('design-review')).toBeUndefined();
  });

  it('closes the room in every participating fleet when the teardown is local', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);

    expect(await module.close('design-review', OPERATOR)).toBe(
      'Room design-review closed; notified 1 member(s). Routed to 1 peer fleet(s): backend.',
    );
    expect(peerCalls.map((call) => call.operation)).toEqual(['close_room']);
  });

  it('delivers peer-originated traffic only to federation-exposed members', async () => {
    exposed = new Set(['alpha']);
    const module = rooms();
    await module.create('design-review', ['alpha', 'beta'], OPERATOR);

    expect(await module.say('design-review', 'from the api', peer('api', 'backend'))).toBe(
      'Room design-review: delivered to 1 member(s).',
    );
    expect(received('beta').at(-1)).not.toContain('from the api');
  });

  it('reaches the local operator on peer-originated traffic, since exposure guards sessions', async () => {
    exposed = new Set(['alpha']);
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);
    await module.join('design-review', undefined, OPERATOR);

    await module.say('design-review', 'from the api', peer('api', 'backend'));
    expect(operatorMessages.at(-1)).toEqual({ text: '[Room: design-review from api@backend] from the api' });

    await module.close('design-review', peer('api', 'backend'));
    expect(operatorMessages.at(-1)).toEqual({
      text: '[Room: design-review] Room closed by api@backend. No action required — this notice is informational.',
    });
  });

  it('treats a peer acting on a room this fleet no longer has as a benign no-op', async () => {
    const module = rooms();

    expect(await module.say('design-review', 'hello', peer('api', 'backend'))).toBe(
      'Room design-review is not present in this fleet.',
    );
    expect(await module.close('design-review', peer('api', 'backend'))).toBe(
      'Room design-review is not present in this fleet.',
    );
  });

  it('refuses a peer that addresses a session it cannot see, without confirming the name', async () => {
    exposed = new Set(['alpha']);
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);

    expect(await module.join('design-review', 'beta', peer('api', 'backend'))).toBe('Unknown session: beta');
    expect(store.getRoomMembers('design-review')).toHaveLength(1);
  });

  it('creates the room a routed join needs, because create_room does not federate', async () => {
    const module = rooms();

    expect(await module.join('planning', 'alpha', peer('api', 'backend'))).toBe('alpha joined room planning.');
    expect(store.getRoom('planning')?.members.map((member) => member.member)).toEqual(['alpha']);
  });

  it('reports an unreachable fleet instead of retrying or queueing for it', async () => {
    peerFailures.set('backend', "Federation fleet 'backend' is unavailable.");
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);

    expect(await module.say('design-review', 'hello', session('beta'))).toBe(
      "Room design-review: delivered to 1 member(s). Could not reach backend (Federation fleet 'backend' is unavailable.).",
    );
  });

  it('publishes only exposed session members, and only for rooms it takes part in', async () => {
    exposed = new Set(['alpha']);
    const module = rooms();
    await module.create('design-review', ['alpha', 'beta'], OPERATOR);
    await module.join('design-review', undefined, OPERATOR);
    await module.create('private', ['beta'], OPERATOR);

    expect(module.publishedRooms()).toEqual([{ name: 'design-review', members: ['alpha'] }]);
  });

  it('warns a session joining a federated room that it takes no part in cross-fleet traffic', async () => {
    exposed = new Set(['alpha']);
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);

    expect(await module.join('design-review', 'beta', OPERATOR)).toBe(
      'beta joined room design-review. beta is not federation-exposed, so it takes part in local room traffic only.',
    );
  });

  it('merges local and peer-published membership into one view', async () => {
    const module = rooms();
    await module.create('design-review', ['alpha'], OPERATOR);
    await module.join('design-review', undefined, OPERATOR);

    expect(JSON.parse(await module.list('design-review'))).toEqual({
      localFleet: 'frontend',
      rooms: [
        {
          room: 'design-review',
          members: [
            { member: 'operator', kind: 'operator', fleet: 'frontend' },
            { member: 'alpha', kind: 'session', fleet: 'frontend', running: true, federationExposed: true },
            { member: 'api', kind: 'session', fleet: 'backend' },
          ],
        },
      ],
    });
  });
});
