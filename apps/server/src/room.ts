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
} from "@omega/shared";
import { applyControl, loadPlayback, type Control } from "./playback";

export type SitResult = "ok" | "seat_taken";

/**
 * One in-memory room: up to MAX_ROOM_MEMBERS members, SEAT_COUNT seats (ADR 0006).
 * Members stand until they sit; anyone beyond the seated ones spectates.
 */
export class Room {
  readonly topic: string;
  private readonly members = new Map<MemberId, Member>();
  private readonly seats: (MemberId | null)[] = Array.from({ length: SEAT_COUNT }, () => null);
  private embed: Embed | null = null;
  /** Null iff there is no embed. */
  private playback: PlaybackState | null = null;
  /** Last rev handed out; survives embed changes so clients never see rev go back. */
  private rev = -1;

  constructor(readonly id: RoomId) {
    this.topic = `room:${id}`;
  }

  /** Adds a member, or returns null when the room is full. */
  join(nickname: Nickname, avatar: Avatar): Member | null {
    if (this.members.size >= MAX_ROOM_MEMBERS) return null;
    const member: Member = { id: crypto.randomUUID(), nickname, avatar };
    this.members.set(member.id, member);
    return member;
  }

  /** Removes a member and frees their seat. */
  leave(memberId: MemberId): void {
    this.free(memberId);
    this.members.delete(memberId);
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
