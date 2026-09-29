import {
  MAX_ROOM_MEMBERS,
  SEAT_COUNT,
  type Avatar,
  type Embed,
  type Member,
  type MemberId,
  type Nickname,
  type RoomId,
  type RoomState,
  type RoomSummary,
  type SeatIndex,
} from "@omega/shared";

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

  setEmbed(embed: Embed | null): void {
    this.embed = embed;
  }

  snapshot(): RoomState {
    return { id: this.id, seats: [...this.seats], members: [...this.members.values()], embed: this.embed };
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
