import {
  DEFAULT_LAYOUT,
  MAX_ROOM_MEMBERS,
  SEAT_COUNT,
  type Avatar,
  type AnyEmbed,
  type Member,
  type MemberId,
  type Nickname,
  type PlaybackState,
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
  /** Members whose player is catching up (ADR 0019, advisory). */
  private readonly catching = new Set<MemberId>();
  /** Members the room was last told (`member-status`) are catching; the relay publishes the difference. */
  private readonly announced = new Set<MemberId>();
  private readonly seats: (MemberId | null)[] = Array.from({ length: SEAT_COUNT }, () => null);
  private embed: AnyEmbed | null = null;
  /** Null iff there is no embed or it is generic (ADR 0024 §7): a generic embed is never synced. */
  private playback: PlaybackState | null = null;
  /** Last rev handed out; survives embed changes so clients never see rev go back. */
  private rev = -1;

  /** The room's furniture (ADR 0021); the owner replaces it with `layout-set` (ADR 0028 §6). */
  private currentLayout: RoomLayout;
  /** Empty for a seeded room without one; then the list shows no title. */
  private currentTitle: string;
  /** Fixed at creation; private rooms are never listed (ADR 0028 §4). */
  readonly visibility: RoomVisibility;
  /** Seeded: never collected, no owner (ADR 0028 §2). */
  readonly pinned: boolean;
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
    this.embed = init.embed ?? null;
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

  /** Removes a member and frees their seat, nickname and client slot. */
  leave(memberId: MemberId): void {
    this.free(memberId);
    this.members.delete(memberId);
    this.catching.delete(memberId);
    this.announced.delete(memberId);
    const held = this.held.get(memberId);
    if (held === undefined) return;
    this.held.delete(memberId);
    this.nameKeys.delete(held.nameKey);
    if (held.client === null) return;
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

  /**
   * Sets the embed and restarts playback at 0. `by` is the sharer.
   * Null embed, or a generic one, clears playback and every catching flag (ADR 0024 §7):
   * `uncaught` lists the members the room must now be told are not catching.
   */
  setEmbed(embed: AnyEmbed | null, by: MemberId | null = null): EmbedSwitch {
    this.embed = embed;
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
    return {
      id: this.id,
      seats: [...this.seats],
      // Absent means false, so only catching members carry the field.
      members: [...this.members.values()].map((m) => (this.catching.has(m.id) ? { ...m, catching: true } : m)),
      embed: this.embed,
      playback: this.playback,
      layout: this.layout,
    };
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
