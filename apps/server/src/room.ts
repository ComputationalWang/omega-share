import {
  MAX_ROOM_MEMBERS,
  SEAT_COUNT,
  type Avatar,
  type Embed,
  type Member,
  type MemberId,
  type Nickname,
  type PlaybackState,
  type RoomId,
  type RoomState,
  type RoomSummary,
  type SeatIndex,
  nicknameKey,
} from "@omega/shared";
import { applyControl, loadPlayback, type Control } from "./playback";

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
  private readonly seats: (MemberId | null)[] = Array.from({ length: SEAT_COUNT }, () => null);
  private embed: Embed | null = null;
  /** Null iff there is no embed. */
  private playback: PlaybackState | null = null;
  /** Last rev handed out; survives embed changes so clients never see rev go back. */
  private rev = -1;

  constructor(readonly id: RoomId) {
    this.topic = `room:${id}`;
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

  /** Sets the embed and restarts playback at 0 (or clears it); returns the new playback. `by` is the sharer. */
  setEmbed(embed: Embed | null, by: MemberId | null = null): PlaybackState | null {
    this.embed = embed;
    this.playback = embed === null ? null : loadPlayback(this.rev, Date.now(), by);
    if (this.playback !== null) this.rev = this.playback.rev;
    return this.playback;
  }

  /** Applies a member's `control`; returns the new playback, or null if it's for no/another embed. */
  control(memberId: MemberId, control: Control): PlaybackState | null {
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
      members: [...this.members.values()],
      embed: this.embed,
      playback: this.playback,
    };
  }

  summary(): RoomSummary {
    let seatedCount = 0;
    for (const s of this.seats) if (s !== null) seatedCount++;
    return { id: this.id, memberCount: this.members.size, seatedCount };
  }

  private free(memberId: MemberId): void {
    const i = this.seats.indexOf(memberId);
    if (i !== -1) this.seats[i] = null;
  }
}
