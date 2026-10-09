import {
  DEFAULT_CONTROL_POLICY,
  DEFAULT_LAYOUT,
  MUTE_MEMORY_MS,
  MAX_ROOM_MEMBERS,
  SEAT_COUNT,
  type Avatar,
  type AnyEmbed,
  type ControlPolicy,
  type Member,
  type MemberId,
  type Nickname,
  type PlaybackState,
  type QueueItem,
  type QueueItemId,
  type RoomId,
  type RoomLayout,
  type RoomState,
  type RoomSummary,
  type RoomVisibility,
  type SeatIndex,
  isSyncedEmbed,
} from "@omega/shared";
import { nicknameKey } from "@omega/shared/confusables";
import { applyControl, loadPlayback, restoredPlayback, type Control } from "./playback";
import { secretMatches } from "./secrets";

export type SitResult = "ok" | "seat_taken";
export type JoinResult = { ok: true; member: Member } | { ok: false; reason: "room_full" | "too_many_members" | "nickname_taken" };

/**
 * Joined members one client key may hold in a room (threat model §6, room squatting). Pending the
 * board's answer to B2 on OME-183: real groups behind one NAT share a key.
 */
export const MAX_MEMBERS_PER_CLIENT = 5;

/** How long after a restart a seat waits for its member to rejoin under the same name (OME-504, ADR 0032). */
export const SEAT_HOLD_MS = 30_000;

/** A seated member's name, as SHA-256 of its `nicknameKey`, and seat: what a graceful restart keeps (ADR 0032). */
export interface HeldSeat {
  nameHash: Uint8Array;
  seat: SeatIndex;
}

/** A fresh queue item id (ADR 0031 §1): 12 random bytes, base64url, 16 chars. Opaque, never reused. */
export const newItemId = (): QueueItemId => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");

const nameHash = (nameKey: string): Uint8Array => new Uint8Array(new Bun.CryptoHasher("sha256").update(nameKey).digest());
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

interface Held {
  /** `nicknameKey` of the member's nickname: unique per room. */
  nameKey: string;
  /** Client key the member counts against, or null when uncapped. */
  client: string | null;
}

/** What `Room.setEmbed` changed besides the embed. */
export interface EmbedSwitch {
  playback: PlaybackState | null;
  uncaught: readonly MemberId[];
}

/**
 * One in-memory room: up to MAX_ROOM_MEMBERS members, SEAT_COUNT seats (ADR 0006).
 * Members stand until they sit; anyone beyond the seated ones spectates.
 */
export class Room {
  readonly topic: string;
  private readonly members = new Map<MemberId, Member>();
  private readonly held = new Map<MemberId, Held>();
  private readonly nameKeys = new Set<string>();
  private readonly perClient = new Map<string, number>();
  /** Members the owner muted (ADR 0030 §3). In memory only. */
  private readonly muted = new Set<MemberId>();
  /**
   * Client keys → Unix ms: a muted member left from there, so a join from it starts muted until then;
   * and a member was kicked from there, so joins from it are refused until then (ADR 0030 §2, §3).
   * In memory only, never stored or logged; expired entries go on the next write.
   */
  private readonly mutedClients = new Map<string, number>();
  private readonly kickedClients = new Map<string, number>();
  /** Members whose player is catching up (ADR 0019, advisory). */
  private readonly catching = new Set<MemberId>();
  /** Members the room was last told (`member-status`) are catching; the relay publishes the difference. */
  private readonly announced = new Set<MemberId>();
  private readonly seats: (MemberId | null)[] = Array.from({ length: SEAT_COUNT }, () => null);
  private embed: AnyEmbed | null = null;
  /** Null iff there is no embed or it is generic (ADR 0024 §7): a generic embed is never synced. */
  private playback: PlaybackState | null = null;
  /** The current embed's queue item id (ADR 0031 §1); null iff there is no embed. */
  private currentItemId: QueueItemId | null = null;
  /** When the current item became current, on the caller's monotonic clock (the `ended` debounce). */
  private currentSince = Number.NEGATIVE_INFINITY;
  /** Upcoming items in play order, at most QUEUE_MAX (ADR 0031 §1). */
  private upcoming: QueueItem[] = [];
  /** Last rev handed out; survives embed changes so clients never see rev go back. */
  private rev = -1;
  /** Seats held across a restart, by hex name hash, until `holdsUntil` (Unix ms). Each is used at most once. */
  private holds = new Map<string, SeatIndex>();
  private holdsUntil = 0;

  /** The room's furniture (ADR 0021); the owner replaces it with `layout-set` (ADR 0028 §6). */
  private currentLayout: RoomLayout;
  /** Empty for a seeded room without one; then the list shows no title. */
  private currentTitle: string;
  /** Who controls playback (ADR 0030 §4); the owner changes it with `control-policy`. */
  private currentControlPolicy: ControlPolicy;
  /** Fixed at creation; private rooms are never listed (ADR 0028 §4). */
  readonly visibility: RoomVisibility;
  /** Never collected by GC: seeded rooms, and rooms the operator pins (`cli.ts rooms pin`). */
  pinned: boolean;
  /** Unix ms; the list shows newer rooms first. */
  readonly createdAt: number;
  /** SHA-256 of the owner token, or null (pinned). Never the token itself. */
  private readonly ownerHash: Uint8Array | null;
  /** SHA-256 of the invite key (private rooms), or null. */
  readonly inviteHash: Uint8Array | null;
  /** Unix ms the room last became occupied or empty; null if nobody ever joined. Room GC reads it. */
  lastActiveAt: number | null;

  /**
   * `embed` is the last one shared before a restart: it comes back paused at 0. Without the
   * ADR 0028 fields the room is a seed: pinned, public, ownerless.
   */
  constructor(
    readonly id: RoomId,
    init: {
      layout?: RoomLayout;
      embed?: AnyEmbed | null;
      title?: string;
      visibility?: RoomVisibility;
      pinned?: boolean;
      createdAt?: number;
      ownerHash?: Uint8Array | null;
      inviteHash?: Uint8Array | null;
      lastActiveAt?: number | null;
      controlPolicy?: ControlPolicy;
      /** The stored current item id; one is minted for an embed stored without (before migration 0005). */
      itemId?: QueueItemId | null;
      /** The stored upcoming items; after a restart nobody is known to have added them. */
      queue?: readonly { id: QueueItemId; embed: AnyEmbed }[];
    } = {},
  ) {
    this.topic = `room:${id}`;
    this.currentLayout = init.layout ?? DEFAULT_LAYOUT;
    this.currentTitle = init.title ?? "";
    this.visibility = init.visibility ?? "public";
    this.pinned = init.pinned ?? true;
    this.createdAt = init.createdAt ?? Date.now();
    this.ownerHash = init.ownerHash ?? null;
    this.inviteHash = init.inviteHash ?? null;
    this.lastActiveAt = init.lastActiveAt ?? null;
    this.currentControlPolicy = init.controlPolicy ?? DEFAULT_CONTROL_POLICY;
    this.embed = init.embed ?? null;
    if (this.embed !== null) this.currentItemId = init.itemId ?? newItemId();
    this.upcoming = (init.queue ?? []).filter((i) => i.id !== this.currentItemId).map((i) => ({ id: i.id, embed: i.embed, by: null }));
    if (this.embed !== null && isSyncedEmbed(this.embed)) {
      this.playback = restoredPlayback(Date.now());
      this.rev = this.playback.rev;
    }
  }

  get layout(): RoomLayout {
    return this.currentLayout;
  }

  get title(): string {
    return this.currentTitle;
  }

  /** Replaces the layout. Seats keep their indices: every valid layout has SEAT_COUNT seat cells (ADR 0028 §6). */
  setLayout(layout: RoomLayout): void {
    this.currentLayout = layout;
  }

  setTitle(title: string): void {
    this.currentTitle = title;
  }

  get controlPolicy(): ControlPolicy {
    return this.currentControlPolicy;
  }

  setControlPolicy(policy: ControlPolicy): void {
    this.currentControlPolicy = policy;
  }

  isMuted(memberId: MemberId): boolean {
    return this.muted.has(memberId);
  }

  /** Mutes or unmutes a member; false if that changed nothing. Unmuting also forgets their address (ADR 0030 §3). */
  setMuted(memberId: MemberId, muted: boolean): boolean {
    if (!this.members.has(memberId) || muted === this.muted.has(memberId)) return false;
    if (muted) {
      this.muted.add(memberId);
      return true;
    }
    this.muted.delete(memberId);
    const client = this.held.get(memberId)?.client ?? null;
    if (client !== null) this.mutedClients.delete(client);
    return true;
  }

  /** Mutes a just-joined member if a muted member left from its address less than MUTE_MEMORY_MS ago. */
  restoreMute(memberId: MemberId, now: number): boolean {
    const client = this.held.get(memberId)?.client ?? null;
    if (client === null || !Room.live(this.mutedClients, client, now)) return false;
    this.muted.add(memberId);
    return true;
  }

  /** Refuses joins from `client` until `until` (Unix ms): the kick cooldown (ADR 0030 §2). */
  coolDown(client: string, until: number, now: number): void {
    Room.remember(this.kickedClients, client, until, now);
  }

  isCoolingDown(client: string, now: number): boolean {
    return Room.live(this.kickedClients, client, now);
  }

  /** Whether `key`'s entry is still running at `now`; an expired one is dropped. */
  private static live(map: Map<string, number>, key: string, now: number): boolean {
    const until = map.get(key);
    if (until === undefined) return false;
    if (now < until) return true;
    map.delete(key);
    return false;
  }

  private static remember(map: Map<string, number>, key: string, until: number, now: number): void {
    for (const [k, at] of map) if (at <= now) map.delete(k);
    map.set(key, until);
  }

  /** Whether the room has an owner token. Seeded rooms don't. */
  get hasOwner(): boolean {
    return this.ownerHash !== null;
  }

  get memberCount(): number {
    return this.members.size;
  }

  /**
   * Adds a member, unless the room is full, `client` already holds MAX_MEMBERS_PER_CLIENT members here,
   * or another member's nickname has the same `nicknameKey`. `client` null means uncapped.
   */
  join(nickname: Nickname, avatar: Avatar, client: string | null = null): JoinResult {
    if (this.members.size >= MAX_ROOM_MEMBERS) return { ok: false, reason: "room_full" };
    if (client !== null && (this.perClient.get(client) ?? 0) >= MAX_MEMBERS_PER_CLIENT) {
      return { ok: false, reason: "too_many_members" };
    }
    const nameKey = nicknameKey(nickname);
    if (this.nameKeys.has(nameKey)) return { ok: false, reason: "nickname_taken" };
    const member: Member = { id: crypto.randomUUID(), nickname, avatar };
    this.members.set(member.id, member);
    this.held.set(member.id, { nameKey, client });
    this.nameKeys.add(nameKey);
    if (client !== null) this.perClient.set(client, (this.perClient.get(client) ?? 0) + 1);
    return { ok: true, member };
  }

  /**
   * Removes a member and frees their seat, nickname and client slot. A muted member's address stays
   * muted here for MUTE_MEMORY_MS after `now` (Unix ms), so a reconnect doesn't lift it (ADR 0030 §3).
   */
  leave(memberId: MemberId, now: number = Date.now()): void {
    this.free(memberId);
    this.members.delete(memberId);
    const wasMuted = this.muted.delete(memberId);
    this.catching.delete(memberId);
    this.announced.delete(memberId);
    const held = this.held.get(memberId);
    if (held === undefined) return;
    this.held.delete(memberId);
    this.nameKeys.delete(held.nameKey);
    if (held.client === null) return;
    if (wasMuted) Room.remember(this.mutedClients, held.client, now + MUTE_MEMORY_MS, now);
    const left = (this.perClient.get(held.client) ?? 1) - 1;
    if (left === 0) this.perClient.delete(held.client);
    else this.perClient.set(held.client, left);
  }

  /** Sits `memberId` on `seat` (moving from any other seat), or stands up on `null`. */
  sit(memberId: MemberId, seat: SeatIndex | null): SitResult {
    if (seat !== null) {
      const occupant = this.seats[seat];
      if (occupant !== null && occupant !== memberId) return "seat_taken";
    }
    this.free(memberId);
    if (seat !== null) this.seats[seat] = memberId;
    return "ok";
  }

  /** Seated members, for a graceful restart: name hashes only, never the nickname (ADR 0032). */
  heldSeats(): HeldSeat[] {
    const held: HeldSeat[] = [];
    this.seats.forEach((memberId, seat) => {
      const nameKey = memberId === null ? undefined : this.held.get(memberId)?.nameKey;
      if (nameKey !== undefined) held.push({ nameHash: nameHash(nameKey), seat });
    });
    return held;
  }

  /** Holds these seats for members rejoining under the same name until `until` (Unix ms). */
  holdSeats(holds: readonly HeldSeat[], until: number): void {
    this.holds = new Map(holds.map((h) => [hex(h.nameHash), h.seat]));
    this.holdsUntil = until;
  }

  /**
   * Sits a just-joined member on the seat held for its name, if the hold hasn't expired and the seat is
   * free; returns the seat, or null. The hold is spent either way.
   */
  claimHeldSeat(memberId: MemberId, now: number): SeatIndex | null {
    if (this.holds.size === 0) return null;
    if (now > this.holdsUntil) {
      this.holds.clear();
      return null;
    }
    const nameKey = this.held.get(memberId)?.nameKey;
    if (nameKey === undefined) return null;
    const key = hex(nameHash(nameKey));
    const seat = this.holds.get(key);
    if (seat === undefined) return null;
    this.holds.delete(key);
    if (this.seats[seat] !== null) return null;
    this.seats[seat] = memberId;
    return seat;
  }

  /** Records a member's advisory catching-up flag (ADR 0019); never touches playback. */
  setCatching(memberId: MemberId, catching: boolean): void {
    if (catching && this.members.has(memberId)) this.catching.add(memberId);
    else this.catching.delete(memberId);
  }

  isCatching(memberId: MemberId): boolean {
    return this.catching.has(memberId);
  }

  /** The member's catching if the room was last told otherwise, now recorded as told; else null. */
  takeCatchingChange(memberId: MemberId): boolean | null {
    const catching = this.catching.has(memberId);
    if (catching === this.announced.has(memberId)) return null;
    if (catching) this.announced.add(memberId);
    else this.announced.delete(memberId);
    return catching;
  }

  /** True while the room shows a generic (unsynced) embed. */
  hasGenericEmbed(): boolean {
    return this.embed !== null && !isSyncedEmbed(this.embed);
  }

  /** The current embed, or null. */
  get currentEmbed(): AnyEmbed | null {
    return this.embed;
  }

  /** The current playback; null with no embed or a generic one. */
  get currentPlayback(): PlaybackState | null {
    return this.playback;
  }

  /** The current item's id (ADR 0031 §1); null iff there is no embed. */
  get itemId(): QueueItemId | null {
    return this.currentItemId;
  }

  /** When the current item became current, on the clock its setter used. */
  get itemSince(): number {
    return this.currentSince;
  }

  /** The upcoming items, in play order. */
  get queue(): readonly QueueItem[] {
    return this.upcoming;
  }

  /** Appends an upcoming item. The caller checks QUEUE_MAX. */
  enqueue(item: QueueItem): void {
    this.upcoming = [...this.upcoming, item];
  }

  /** Drops an upcoming item; false if there was none with that id. */
  dequeue(itemId: QueueItemId): boolean {
    const next = this.upcoming.filter((i) => i.id !== itemId);
    if (next.length === this.upcoming.length) return false;
    this.upcoming = next;
    return true;
  }

  /**
   * Makes the first upcoming item current at `since` (ADR 0031 §5): its embed loads at 0, by nobody.
   * Null with an empty queue.
   */
  advance(since: number): { item: QueueItem; embedSwitch: EmbedSwitch } | null {
    const [item, ...rest] = this.upcoming;
    if (item === undefined) return null;
    this.upcoming = rest;
    return { item, embedSwitch: this.setEmbed(item.embed, null, item.id, since) };
  }

  /**
   * Sets the embed and restarts playback at 0. `by` is the sharer. The embed becomes the current item
   * `itemId` (minted if null) at `since`; a null embed has no item.
   * Null embed, or a generic one, clears playback and every catching flag (ADR 0024 §7):
   * `uncaught` lists the members the room must now be told are not catching.
   */
  setEmbed(
    embed: AnyEmbed | null,
    by: MemberId | null = null,
    itemId: QueueItemId | null = null,
    since = Number.NEGATIVE_INFINITY,
  ): EmbedSwitch {
    this.embed = embed;
    this.currentItemId = embed === null ? null : (itemId ?? newItemId());
    this.currentSince = since;
    this.playback = embed === null || !isSyncedEmbed(embed) ? null : loadPlayback(this.rev, Date.now(), by);
    if (this.playback !== null) {
      this.rev = this.playback.rev;
      return { playback: this.playback, uncaught: [] };
    }
    const uncaught = [...this.announced];
    this.catching.clear();
    this.announced.clear();
    return { playback: null, uncaught };
  }

  /** Applies a member's `control`; returns the new playback, or null if it's for no/another/a generic embed. */
  control(memberId: MemberId, control: Control): PlaybackState | null {
    if (this.embed === null || !isSyncedEmbed(this.embed)) return null;
    const next = applyControl(this.playback, this.embed, control, memberId, Date.now());
    if (next === null) return null;
    this.playback = next;
    this.rev = next.rev;
    return next;
  }

  snapshot(): RoomState {
    const state: RoomState = {
      id: this.id,
      seats: [...this.seats],
      // Absent means false, so only catching and muted members carry the fields.
      members: [...this.members.values()].map((m) => this.view(m)),
      embed: this.embed,
      playback: this.playback,
      layout: this.layout,
      controlPolicy: this.currentControlPolicy,
    };
    // Like the summary: an untitled (seeded) room sends no title key; nor an empty queue or no item a queue key.
    if (this.title !== "") state.title = this.title;
    if (this.currentItemId !== null) state.itemId = this.currentItemId;
    if (this.upcoming.length > 0) state.queue = this.upcoming;
    return state;
  }

  /** A member as the room sees it: `catching` and `muted` only when true. */
  view(member: Member): Member {
    const catching = this.catching.has(member.id);
    const muted = this.muted.has(member.id);
    if (!catching && !muted) return member;
    return { ...member, ...(catching ? { catching } : {}), ...(muted ? { muted } : {}) };
  }

  /** Whether `token` is this room's owner token (constant-time; a pinned room has no owner). */
  isOwner(token: string): boolean {
    return secretMatches(this.ownerHash, token);
  }

  /** Whether `key` is this private room's invite key (constant-time; a public room has none). */
  isInvited(key: string): boolean {
    return secretMatches(this.inviteHash, key);
  }

  summary(): RoomSummary {
    let seatedCount = 0;
    for (const s of this.seats) if (s !== null) seatedCount++;
    const counts = { id: this.id, memberCount: this.members.size, seatedCount };
    return this.title === "" ? counts : { ...counts, title: this.title };
  }

  private free(memberId: MemberId): void {
    const i = this.seats.indexOf(memberId);
    if (i !== -1) this.seats[i] = null;
  }
}
