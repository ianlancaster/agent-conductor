import { ROOM_NAME_PATTERN, type SessionConfig } from '../config/schema.js';
import type { ChannelMessage } from '../channels/types.js';
import type { ConductorEventPublisher } from '../events/types.js';
import { log } from '../logger.js';
import type { RoomMemberKind, Store } from '../store/index.js';
import type { DeliveryQueue } from './delivery.js';
import { InvalidRequestError } from './errors.js';
import type { SessionStateManager } from './state.js';
import { roomEnvelope, roomNoticeEnvelope } from './utils.js';

/** Who is acting, resolved from the canonical operation actor. */
export interface RoomCaller {
  /** Envelope signature: `alpha`, `operator`, `alpha@backend`, or `operator@backend`. */
  name: string;
  /** Codename when the caller is a session in this fleet. */
  localSession?: string;
  /** True when the caller is this fleet's operator. */
  localOperator: boolean;
  /** Set when the call arrived through the federation ingress. */
  remote?: { fleet: string; kind: RoomMemberKind };
}

/** Peer-facing seam. Absent when federation is disabled. */
export interface RoomFederation {
  readonly localFleet: string;
  /** Re-read the rendezvous directory so the peer view is current. */
  refresh(): Promise<void>;
  /** Room membership peers publish about themselves. Never includes the local fleet. */
  peerRooms(): { fleet: string; room: string; members: string[] }[];
  invokeOnPeer(
    fleet: string,
    operation: string,
    args: Record<string, unknown>,
    origin: { session: string; kind: RoomMemberKind },
  ): Promise<unknown>;
}

export interface RoomsDeps {
  store: Store;
  delivery: DeliveryQueue;
  states: SessionStateManager;
  sessions(): Map<string, SessionConfig>;
  channelSend(message: ChannelMessage): Promise<boolean>;
  /** Sessions this fleet publishes to peers. Undefined when federation is disabled. */
  exposedSessions?(): ReadonlySet<string>;
  /**
   * Republish the peer registry record after a membership change. Awaited by
   * the membership operations so a join is visible to peers before the caller
   * can speak into the room.
   */
  onMembershipChanged?(): void | Promise<void>;
  events?: ConductorEventPublisher;
  /** Resolved lazily so the federation router can be constructed after this module. */
  federation?(): RoomFederation | undefined;
}

interface FanOutTally {
  delivered: string[];
  skipped: string[];
}

/**
 * Named group conversations. A room is a member set plus fan-out; Conductor
 * never decides who speaks, when a meeting ends, or what it was about.
 *
 * Cross-fleet rooms are decentralized: each fleet owns its own members and
 * publishes them in its peer registry record. A locally-originated fan-out
 * calls each participating fleet directly, and a peer-originated call acts on
 * local members only — so a room message crosses at most one fleet boundary
 * and the topology stays loop-free without message identity or a TTL.
 */
export class Rooms {
  constructor(private readonly deps: RoomsDeps) {}

  async create(room: string, members: readonly string[] | undefined, caller: RoomCaller): Promise<string> {
    const name = this.validName(room);
    const requested = [...new Set(members ?? [])];
    for (const codename of requested) this.mustBeRegistered(codename);

    const created = this.deps.store.createRoom(name);
    if (created) {
      this.deps.events?.emit({ type: 'room.created', room: name, by: caller.name });
    }

    const added: string[] = [];
    for (const codename of requested) {
      if (!this.deps.store.addRoomMember(name, 'session', codename)) continue;
      added.push(codename);
      this.deps.events?.emit({
        type: 'room.membership.changed',
        room: name,
        member: codename,
        kind: 'session',
        change: 'joined',
        by: caller.name,
      });
    }
    if (created || added.length > 0) await this.deps.onMembershipChanged?.();
    await this.notifyAdded(name, added, caller);

    const summary = added.length === 0 ? 'no new members' : `members: ${added.join(', ')}`;
    return created ? `Room ${name} created with ${summary}.` : `Room ${name} already exists; added ${summary}.`;
  }

  async join(room: string, codename: string | undefined, caller: RoomCaller): Promise<string> {
    const name = this.validName(room);
    const target = this.resolveTarget(name, codename, caller, 'join');
    if (typeof target === 'string') return target;

    // A routed join is the only way a peer can reach this fleet's rooms, so it
    // creates the room it needs. Locally, create_room stays the explicit gate.
    if (!this.deps.store.hasRoom(name)) {
      if (caller.remote === undefined) throw new InvalidRequestError(this.unknownRoom(name));
      this.deps.store.createRoom(name);
      this.deps.events?.emit({ type: 'room.created', room: name, by: caller.name });
    }

    if (!this.deps.store.addRoomMember(name, target.kind, target.member)) {
      return `${this.label(target)} is already in room ${name}.`;
    }
    this.deps.events?.emit({
      type: 'room.membership.changed',
      room: name,
      member: target.member,
      kind: target.kind,
      change: 'joined',
      by: caller.name,
    });
    await this.deps.onMembershipChanged?.();

    if (target.kind === 'session' && target.member !== caller.localSession) {
      await this.notifyAdded(name, [target.member], caller);
    }
    return `${this.label(target)} joined room ${name}.${this.exposureCaveat(name, target)}`;
  }

  async leave(room: string, codename: string | undefined, caller: RoomCaller): Promise<string> {
    const name = this.validName(room);
    const target = this.resolveTarget(name, codename, caller, 'leave');
    if (typeof target === 'string') return target;
    if (!this.deps.store.hasRoom(name)) throw new InvalidRequestError(this.unknownRoom(name));

    if (!this.deps.store.removeRoomMember(name, target.kind, target.member)) {
      return `${this.label(target)} is not in room ${name}.`;
    }
    this.deps.events?.emit({
      type: 'room.membership.changed',
      room: name,
      member: target.member,
      kind: target.kind,
      change: 'left',
      by: caller.name,
    });
    await this.deps.onMembershipChanged?.();

    if (target.kind === 'session' && target.member !== caller.localSession) {
      await this.deliverToSession(target.member, roomNoticeEnvelope(name, `You were removed by ${caller.name}.`));
    }
    return `${this.label(target)} left room ${name}.`;
  }

  async close(room: string, caller: RoomCaller): Promise<string> {
    const name = this.validName(room);
    const stored = this.deps.store.getRoom(name);
    if (stored === undefined) {
      // A peer resolved this fleet from a published roster it cannot re-check.
      // Tearing down an already-absent room is the intended end state, so it is
      // a benign no-op rather than a failure reported back as unreachable.
      if (caller.remote !== undefined) return `Room ${name} is not present in this fleet.`;
      throw new InvalidRequestError(this.unknownRoom(name));
    }

    const notice = roomNoticeEnvelope(name, `Room closed by ${caller.name}.`);
    let notified = 0;
    for (const member of this.visibleMembers(stored.members, caller)) {
      if (member.kind === 'operator') {
        if (caller.localOperator) continue;
        await this.deps.channelSend({ text: notice });
        notified += 1;
        continue;
      }
      if (member.member === caller.localSession) continue;
      if (await this.deliverToSession(member.member, notice)) notified += 1;
    }

    this.deps.store.deleteRoom(name);
    this.deps.events?.emit({ type: 'room.closed', room: name, by: caller.name, memberCount: notified });
    await this.deps.onMembershipChanged?.();

    const local = `Room ${name} closed; notified ${String(notified)} member(s).`;
    if (caller.remote !== undefined) return local;
    return `${local}${await this.fanOutToPeers(name, 'close_room', {}, caller)}`;
  }

  async say(room: string, message: string, caller: RoomCaller): Promise<string> {
    const name = this.validName(room);
    const stored = this.deps.store.getRoom(name);
    if (stored === undefined) {
      // Same race as close: the peer chose this fleet from published membership
      // that has since gone. Nobody local is in the room, which is exactly what
      // "delivered to nobody" means.
      if (caller.remote !== undefined) return `Room ${name} is not present in this fleet.`;
      throw new InvalidRequestError(this.unknownRoom(name));
    }

    const envelope = roomEnvelope(name, caller.name, message);
    const tally: FanOutTally = { delivered: [], skipped: [] };
    for (const member of this.visibleMembers(stored.members, caller)) {
      if (member.kind === 'operator') {
        if (caller.localOperator) continue;
        await this.deps.channelSend({ text: envelope });
        tally.delivered.push('operator');
        continue;
      }
      if (member.member === caller.localSession) continue;
      if (await this.deliverToSession(member.member, envelope)) tally.delivered.push(member.member);
      else tally.skipped.push(member.member);
    }

    this.deps.store.insertMessage(caller.name, name, 'room', message);
    this.deps.events?.emit({
      type: 'room.message',
      room: name,
      sender: caller.name,
      recipientCount: tally.delivered.length,
      byteCount: Buffer.byteLength(message, 'utf8'),
    });

    const parts = [`Room ${name}: delivered to ${String(tally.delivered.length)} member(s)`];
    if (tally.skipped.length > 0) parts.push(`skipped ${tally.skipped.join(', ')} (not running)`);
    const local = `${parts.join('; ')}.`;
    if (caller.remote !== undefined) return local;
    return `${local}${await this.fanOutToPeers(name, 'send_to_room', { message }, caller)}`;
  }

  /** Local rooms merged with the membership peers publish about themselves. */
  async list(room: string | undefined): Promise<string> {
    const filter = room === undefined ? undefined : this.validName(room);
    const federation = this.deps.federation?.();
    await this.refreshPeers(federation);
    const exposed = this.deps.exposedSessions?.();
    const localFleet = federation?.localFleet;

    const rooms = new Map<string, Record<string, unknown>[]>();
    for (const stored of this.deps.store.getRooms()) {
      if (filter !== undefined && stored.room !== filter) continue;
      rooms.set(
        stored.room,
        stored.members.map((member) => ({
          member: member.member,
          kind: member.kind,
          ...(localFleet === undefined ? {} : { fleet: localFleet }),
          ...(member.kind === 'session'
            ? {
                running: this.deps.states.get(member.member)?.running === true,
                ...(exposed === undefined ? {} : { federationExposed: exposed.has(member.member) }),
              }
            : {}),
        })),
      );
    }
    for (const peer of federation?.peerRooms() ?? []) {
      if (filter !== undefined && peer.room !== filter) continue;
      const members = rooms.get(peer.room) ?? [];
      for (const member of peer.members) members.push({ member, kind: 'session', fleet: peer.fleet });
      rooms.set(peer.room, members);
    }

    return JSON.stringify(
      {
        ...(localFleet === undefined ? {} : { localFleet }),
        rooms: [...rooms.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, members]) => ({ room: name, members })),
      },
      null,
      2,
    );
  }

  /** Drop a deregistered session from every room it belonged to. */
  removeSession(codename: string): void {
    const rooms = this.deps.store.removeSessionFromRooms(codename);
    if (rooms.length === 0) return;
    for (const room of rooms) {
      this.deps.events?.emit({
        type: 'room.membership.changed',
        room,
        member: codename,
        kind: 'session',
        change: 'left',
        by: 'conductor',
      });
    }
    void this.deps.onMembershipChanged?.();
  }

  /** Exposed session members of rooms this fleet participates in, for the peer registry record. */
  publishedRooms(): { name: string; members: string[] }[] {
    const exposed = this.deps.exposedSessions?.();
    if (exposed === undefined) return [];
    const published: { name: string; members: string[] }[] = [];
    for (const stored of this.deps.store.getRooms()) {
      const members = stored.members
        .filter((member) => member.kind === 'session' && exposed.has(member.member))
        .map((member) => member.member)
        .sort();
      if (members.length > 0) published.push({ name: stored.room, members });
    }
    return published;
  }

  private validName(room: string): string {
    if (!ROOM_NAME_PATTERN.test(room)) {
      throw new InvalidRequestError(
        `Invalid room name '${room}'. Room names must match ${ROOM_NAME_PATTERN.source} — lowercase letters or digits, then letters, digits, or hyphens.`,
      );
    }
    return room;
  }

  private unknownRoom(room: string): string {
    return `Unknown room: ${room}. Create it with create_room before using it.`;
  }

  private mustBeRegistered(codename: string): void {
    if (!this.deps.sessions().has(codename)) throw new InvalidRequestError(`Unknown session: ${codename}`);
  }

  /**
   * Resolve the membership target. Returns a message string when a peer caller
   * addressed a session it cannot see, preserving the same ambiguity the other
   * routable operations already keep.
   */
  private resolveTarget(
    room: string,
    codename: string | undefined,
    caller: RoomCaller,
    verb: string,
  ): { kind: RoomMemberKind; member: string } | string {
    if (codename === undefined) {
      if (caller.localSession !== undefined) return { kind: 'session', member: caller.localSession };
      if (caller.localOperator) return { kind: 'operator', member: 'operator' };
      throw new InvalidRequestError(
        `A remote caller must name the session to ${verb} in room ${room}; it cannot ${verb} itself in another fleet.`,
      );
    }
    if (caller.remote !== undefined && !(this.deps.exposedSessions?.().has(codename) ?? true)) {
      return `Unknown session: ${codename}`;
    }
    this.mustBeRegistered(codename);
    return { kind: 'session', member: codename };
  }

  private label(target: { kind: RoomMemberKind; member: string }): string {
    return target.kind === 'operator' ? 'The operator' : target.member;
  }

  /** A peer may only reach the sessions this fleet publishes; local traffic reaches everyone. */
  private visibleMembers(
    members: readonly { kind: RoomMemberKind; member: string }[],
    caller: RoomCaller,
  ): { kind: RoomMemberKind; member: string }[] {
    if (caller.remote === undefined) return [...members];
    const exposed = this.deps.exposedSessions?.() ?? new Set<string>();
    // Exposure protects unexposed *sessions* from peer reach. The operator is
    // not a session and joined this room deliberately, so a peer speaking in a
    // shared room still reaches the human facilitating it — without which an
    // operator could not follow a cross-fleet conversation at all.
    return members.filter((member) => member.kind === 'operator' || exposed.has(member.member));
  }

  private exposureCaveat(room: string, target: { kind: RoomMemberKind; member: string }): string {
    if (target.kind !== 'session') return '';
    const exposed = this.deps.exposedSessions?.();
    if (exposed === undefined || exposed.has(target.member)) return '';
    const federated = (this.deps.federation?.()?.peerRooms() ?? []).some((peer) => peer.room === room);
    if (!federated) return '';
    return ` ${target.member} is not federation-exposed, so it takes part in local room traffic only.`;
  }

  private async notifyAdded(room: string, added: readonly string[], caller: RoomCaller): Promise<void> {
    if (added.length === 0) return;
    const roster = this.roster(room);
    for (const codename of added) {
      await this.deliverToSession(
        codename,
        roomNoticeEnvelope(
          room,
          `You were added by ${caller.name}.${roster} Use send_to_room to speak to everyone in this room.`,
        ),
      );
    }
  }

  private roster(room: string): string {
    const federation = this.deps.federation?.();
    const local = (this.deps.store.getRoom(room)?.members ?? []).map((member) =>
      member.kind === 'operator' ? 'operator' : member.member,
    );
    const remote = (federation?.peerRooms() ?? [])
      .filter((peer) => peer.room === room)
      .flatMap((peer) => peer.members.map((member) => `${member}@${peer.fleet}`));
    const all = [...local, ...remote];
    return all.length === 0 ? '' : ` Members: ${all.join(', ')}.`;
  }

  private async deliverToSession(codename: string, text: string): Promise<boolean> {
    if (this.deps.states.get(codename)?.running !== true) return false;
    try {
      // Room traffic is a broadcast: ephemeral, never a durable receipt, and it
      // never launches a session that is deliberately stopped.
      await this.deps.delivery.deliverOrQueue(codename, text);
      return true;
    } catch (error) {
      log().warn('rooms', `delivery to ${codename} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** A stale peer view must not silently drop a fleet from a conversation. */
  private async refreshPeers(federation: RoomFederation | undefined): Promise<void> {
    if (federation === undefined) return;
    try {
      await federation.refresh();
    } catch (error) {
      log().warn('rooms', `could not refresh the peer view: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** One direct call per participating peer. Peer-originated calls never reach here. */
  private async fanOutToPeers(
    room: string,
    operation: string,
    args: Record<string, unknown>,
    caller: RoomCaller,
  ): Promise<string> {
    const federation = this.deps.federation?.();
    if (federation === undefined) return '';
    await this.refreshPeers(federation);
    const fleets = [
      ...new Set(
        federation
          .peerRooms()
          .filter((peer) => peer.room === room)
          .map((peer) => peer.fleet),
      ),
    ];
    if (fleets.length === 0) return '';

    const origin = caller.localOperator
      ? ({ session: 'operator', kind: 'operator' } as const)
      : ({ session: caller.localSession ?? 'operator', kind: 'session' } as const);
    const reached: string[] = [];
    const failed: string[] = [];
    for (const fleet of fleets.sort()) {
      try {
        await federation.invokeOnPeer(fleet, operation, { ...args, room }, origin);
        reached.push(fleet);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log().warn('rooms', `${room}: ${operation} to fleet ${fleet} failed: ${reason}`);
        failed.push(`${fleet} (${reason})`);
      }
    }
    const parts: string[] = [];
    if (reached.length > 0) parts.push(` Routed to ${String(reached.length)} peer fleet(s): ${reached.join(', ')}.`);
    if (failed.length > 0) parts.push(` Could not reach ${failed.join('; ')}.`);
    return parts.join('');
  }
}
