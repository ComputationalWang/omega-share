import type { ServerWebSocket } from "bun";
import {
  CLOSE_CODES,
  KICK_COOLDOWN_MS,
  type ClientMessage,
  type ErrorCode,
  type MemberId,
  type ResumeToken,
  type ServerMessage,
  type ShareToken,
} from "@omega/shared";
import { newShareGrant, type ShareGrant } from "./http";
import type { CountedClose } from "./metrics";
import { KeyedLimiter, type Clock, type TokenBucket } from "./rate-limit";
import type { Room } from "./room";
import type { PerRoom, RoomRegistry } from "./rooms";
import { mintResumeToken, mintSecret } from "./secrets";
import { FAILED_INVITE_BURST, FAILED_INVITE_PER_SECOND, FAILED_OWNER_BURST, FAILED_OWNER_PER_SECOND, type MemberBuckets } from "./ws-limits";

export interface ConnData {
  room: Room;
  /** Client key (ADR 0015 §5). */
  ip: string;
  /** False for loopback peers, which skip the per-key limits (join limiter, members per key). */
  keyed: boolean;
  /** The member this socket is, or null before join, after leave and once another socket resumed it. */
  session: Session | null;
  /** L1: every frame. */
  bucket: TokenBucket;
  /** The socket's own until it joins; then its session's, so a resume doesn't refill them (ADR 0043). */
  buckets: MemberBuckets;
  /** Frames dropped in a row by any limiter. The first of a streak gets the one `rate_limited` notice. */
  dropped: number;
  /** `bad_message`s over the socket's life. */
  badMessages: number;
  joinTimer: Timer | null;
}

/**
 * A joined member's identity (ADR 0043). It outlives its socket while held: an unexpected close of a
 * durable member keeps it for the grace window (`RESUME_GRACE_MS`), away, until a resume reattaches it or the hold expires.
 */
export interface Session {
  readonly room: Room;
  readonly memberId: MemberId;
  /** Joined with the room's owner token (ADR 0028 §3): may send `layout-set`, `title-set` and moderation (ADR 0030). */
  readonly owner: boolean;
  /** Authorizes this member's shares until it leaves, is kicked or its hold expires; only ever sent to its own socket. */
  readonly shareToken: ShareToken;
  /** Null for a legacy join, which departs on close. Sent only in this member's snapshots; never logged. */
  readonly resumeToken: ResumeToken | null;
  /** Client key the member counts against, null when uncapped; moves with a resume from elsewhere. */
  client: string | null;
  /** The one live socket; null while held. A callback acts only while it still owns the session. */
  ws: Conn | null;
  /** Cancels the hold's expiry; null unless held. */
  cancelExpiry: (() => void) | null;
  readonly buckets: MemberBuckets;
  /** `member-status` coalescing (ADR 0019 §3). */
  status: StatusRelay;
}

interface StatusRelay {
  /** When it was published (`now` ms); -Infinity before the first. */
  at: number;
  /** The trailing publish, while one is pending. */
  timer: Timer | null;
}
const freshStatus = (): StatusRelay => ({ at: Number.NEGATIVE_INFINITY, timer: null });
export type Conn = ServerWebSocket<ConnData>;

/** Runs `run` after `ms`; returns its cancel. Tests inject one driven by their fake clock. */
export type Schedule = (run: () => void, ms: number) => () => void;
/** Never keeps the process alive. */
export const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};
/** 16 random bytes, base64url without padding: 22 chars (ADR 0015). */
const mintShareToken = (): ShareToken => mintSecret();

const encode = (msg: ServerMessage): string => JSON.stringify(msg);
const sendError = (ws: Conn, code: ErrorCode, message: string): void => {
  ws.send(encode({ type: "error", code, message }));
};

interface SessionsDeps {
  rooms: RoomRegistry;
  publish: (topic: string, data: string) => void;
  now: Clock;
  wallNow: () => number;
  schedule: Schedule;
  resumeGraceMs: number;
  occupancyChanged: (room: Room) => void;
  /** ws.ts's counted close, so `GET /metrics` sees every close. */
  closeWith: (ws: Conn, code: CountedClose, reason: string) => void;
  /** Counts a `bad_message`-like failure; false once the socket is closing. */
  countBad: (ws: Conn) => boolean;
  clearJoinTimer: (ws: Conn) => void;
}

/** Members of every room, live or held (ADR 0043): join, resume, hold, end and kick, with their tokens. */
export function createSessions({
  rooms,
  publish,
  now,
  wallNow,
  schedule,
  resumeGraceMs,
  occupancyChanged,
  closeWith,
  countBad,
  clearJoinTimer,
}: SessionsDeps) {
  // Loopback peers too, like failed shares: a wrong secret is never local dev's normal path.
  const failedOwners = new KeyedLimiter(FAILED_OWNER_BURST, FAILED_OWNER_PER_SECOND, 1024, now);
  const failedInvites = new KeyedLimiter(FAILED_INVITE_BURST, FAILED_INVITE_PER_SECOND, 1024, now);
  /** Share tokens of the room's members, held ones included. Dropped when empty. */
  const grants = rooms.perRoom(() => new Map<ShareToken, ShareGrant>());
  /** The room's members, live or held. Dropped when empty. */
  const sessions = rooms.perRoom(() => new Map<MemberId, Session>());
  /** Durable members by resume token: a token resumes only in its own room. Dropped when empty. */
  const resumable = rooms.perRoom(() => new Map<ResumeToken, Session>());
  const forget = <K, V>(map: PerRoom<Map<K, V>>, room: Room, key: K): void => {
    const entries = map.peek(room);
    if (entries === undefined) return;
    entries.delete(key);
    if (entries.size === 0) map.drop(room);
  };

  /**
   * A join with a wrong secret: counts toward the 4400 close and takes from `limiter`. True if the
   * caller may go on; false once the socket is closing or the bucket is dry (then `rate_limited`).
   */
  const failedSecret = (ws: Conn, limiter: KeyedLimiter, message: string): boolean => {
    if (!countBad(ws)) return false;
    if (limiter.take(ws.data.ip)) return true;
    ws.send(encode({ type: "error", code: "rate_limited", message, retryAfterMs: limiter.retryAfterMs(ws.data.ip) }));
    return false;
  };

  const stopStatus = (session: Session): void => {
    if (session.status.timer !== null) clearTimeout(session.status.timer);
    session.status = freshStatus();
  };

  /**
   * Ends a member: revokes its resume and share tokens and frees its seat, slot, name and quota. The
   * caller announces it. `closing`: its socket, if any, is closing anyway, so isn't unsubscribed.
   */
  const end = (session: Session, closing: boolean): void => {
    const { room, memberId } = session;
    session.cancelExpiry?.();
    session.cancelExpiry = null;
    // The flag leaves with the member: `member-left` says it all (ADR 0019 §3).
    stopStatus(session);
    forget(sessions, room, memberId);
    if (session.resumeToken !== null) forget(resumable, room, session.resumeToken);
    forget(grants, room, session.shareToken);
    const ws = session.ws;
    session.ws = null;
    if (ws !== null) {
      ws.data.session = null;
      if (!closing) ws.unsubscribe(room.topic);
    }
    room.leave(memberId, wallNow());
    // Not when the room itself is going: its row is about to be deleted.
    if (room.memberCount === 0 && rooms.has(room)) occupancyChanged(room);
  };

  /**
   * A durable member's socket closed without `leave` (ADR 0043): keep everything but the socket for
   * resumeGraceMs. Catching is cleared, away is published once, and one timer ends the hold.
   */
  const hold = (session: Session): void => {
    const { room, memberId } = session;
    session.ws = null;
    stopStatus(session);
    room.setCatching(memberId, false);
    if (room.takeCatchingChange(memberId) !== null) publish(room.topic, encode({ type: "member-status", memberId, catching: false }));
    if (room.setAway(memberId, true)) publish(room.topic, encode({ type: "member-presence", memberId, away: true }));
    const cancel = schedule(() => {
      // Stale unless this hold is still the session's: a resume or an end cancels it, this checks anyway.
      if (session.cancelExpiry !== cancel || session.ws !== null) return;
      end(session, true);
      publish(room.topic, encode({ type: "member-left", memberId, reason: "left" }));
    }, resumeGraceMs);
    session.cancelExpiry = cancel;
  };

  /**
   * Reattaches the held (or still live) member `token` names, before any nickname, capacity, invite or
   * cooldown check (ADR 0043). Any token that doesn't name one of this room's members gets the same
   * `resume_expired`, and the socket stays unjoined: never a fresh member in its place.
   */
  const resume = (ws: Conn, room: Room, token: ResumeToken): void => {
    const session = resumable.peek(room)?.get(token);
    if (session === undefined) {
      sendError(ws, "resume_expired", "session expired");
      return;
    }
    const { memberId } = session;
    // Another address: the quota slot moves with it, or the resume is refused and the hold stays.
    const client = ws.data.keyed ? ws.data.ip : null;
    if (client !== session.client) {
      if (!room.moveClient(memberId, client)) {
        sendError(ws, "too_many_members", "too many members from your address in this room");
        return;
      }
      session.client = client;
    }
    clearJoinTimer(ws);
    // One socket per token: the old one, still open, hears nothing more and closes as replaced.
    const old = session.ws;
    if (old !== null) {
      old.data.session = null;
      old.unsubscribe(room.topic);
      closeWith(old, CLOSE_CODES.SESSION_REPLACED, "session replaced");
    }
    session.cancelExpiry?.();
    session.cancelExpiry = null;
    session.ws = ws;
    ws.data.session = session;
    ws.data.buckets = session.buckets;
    const back = room.setAway(memberId, false);
    ws.send(
      encode({
        type: "snapshot",
        self: memberId,
        room: room.snapshot(),
        shareToken: session.shareToken,
        resumeToken: token,
        resumed: true,
        ...(session.owner ? { owner: true } : {}),
      }),
    );
    ws.subscribe(room.topic);
    // No leave/join pair: the room only hears that the member is back.
    if (back) ws.publish(room.topic, encode({ type: "member-presence", memberId, away: false }));
  };

  /** A `join` on a socket that has no session yet. */
  const join = (ws: Conn, msg: Extract<ClientMessage, { type: "join" }>): void => {
    const { room } = ws.data;
    if (msg.resumeToken !== undefined) {
      resume(ws, room, msg.resumeToken);
      return;
    }
    // Secrets are compared by hash in constant time and never echoed or logged (ADR 0028 §3).
    const owner = msg.ownerToken !== undefined && room.isOwner(msg.ownerToken);
    // A wrong owner token still joins, as a guest, while its bucket lasts.
    if (msg.ownerToken !== undefined && !owner && !failedSecret(ws, failedOwners, "too many wrong owner tokens, slow down")) return;
    // Kicked from this address less than KICK_COOLDOWN_MS ago: closed before any snapshot. The owner is never locked out (ADR 0030 §2).
    if (!owner && ws.data.keyed && room.isCoolingDown(ws.data.ip, wallNow())) {
      closeWith(ws, CLOSE_CODES.KICKED, "kicked");
      return;
    }
    if (room.visibility === "private" && !owner && !(msg.inviteKey !== undefined && room.isInvited(msg.inviteKey))) {
      // Like nickname_taken: the socket stays open and unjoined, and hears nothing from the room.
      if (failedSecret(ws, failedInvites, "too many wrong invite keys, slow down")) {
        sendError(ws, "invite_required", "this room is private: use its invite link");
      }
      return;
    }
    const client = ws.data.keyed ? ws.data.ip : null;
    const joined = room.join(msg.nickname, msg.avatar, client);
    if (!joined.ok) {
      if (joined.reason === "room_full") {
        ws.send(encode({ type: "room-full" }));
        closeWith(ws, CLOSE_CODES.ROOM_FULL, "room full");
      } else if (joined.reason === "nickname_taken") {
        sendError(ws, "nickname_taken", "that name is taken in this room");
      } else {
        sendError(ws, "too_many_members", "too many members from your address in this room");
      }
      return;
    }
    const member = joined.member;
    clearJoinTimer(ws);
    // Back after a restart under the same name: the seat it held, in its snapshot and, after the join, for the room.
    const heldSeat = room.claimHeldSeat(member.id, wallNow());
    // A muted member's address, back within MUTE_MEMORY_MS, starts muted; the owner never does (ADR 0030 §3).
    if (!owner) room.restoreMute(member.id, wallNow());
    const shareToken = mintShareToken();
    // Only an opted-in join gets a resume token (ADR 0043); a legacy one departs on close as before.
    const resumeToken = msg.durableSession === true ? mintResumeToken() : null;
    const joinedSession: Session = {
      room,
      memberId: member.id,
      owner,
      shareToken,
      resumeToken,
      client,
      ws,
      cancelExpiry: null,
      buckets: ws.data.buckets,
      status: freshStatus(),
    };
    ws.data.session = joinedSession;
    sessions.get(room).set(member.id, joinedSession);
    if (resumeToken !== null) resumable.get(room).set(resumeToken, joinedSession);
    grants.get(room).set(shareToken, newShareGrant(member.id, owner, ws.data.buckets.queue));
    // Only the member's own snapshot carries its tokens or says it owns the room; nothing of either is ever broadcast.
    ws.send(
      encode({
        type: "snapshot",
        self: member.id,
        room: room.snapshot(),
        shareToken,
        ...(resumeToken === null ? {} : { resumeToken }),
        ...(owner ? { owner: true } : {}),
      }),
    );
    ws.subscribe(room.topic);
    ws.publish(room.topic, encode({ type: "member-joined", member: room.view(member) }));
    if (heldSeat !== null) ws.publish(room.topic, encode({ type: "seat-changed", memberId: member.id, seat: heldSeat }));
    if (room.memberCount === 1) occupancyChanged(room);
  };

  return {
    join,
    /** Explicit `leave`: no grace, both tokens die now. */
    leave(session: Session): void {
      end(session, false);
      publish(session.room.topic, encode({ type: "member-left", memberId: session.memberId }));
    },
    /** `ws` closed: a durable member is held, a legacy one leaves. */
    closed(ws: Conn): void {
      const session = ws.data.session;
      // Null too for a socket another one replaced: its close never touches the member (ADR 0043).
      if (session?.ws !== ws) return;
      ws.data.session = null;
      if (session.resumeToken !== null) {
        hold(session);
        return;
      }
      end(session, true);
      publish(session.room.topic, encode({ type: "member-left", memberId: session.memberId }));
    },
    /** The guest member `id` names in `room`, live or held (ADR 0043): not the sender, not owner-joined. */
    targetOf(room: Room, sender: MemberId, id: MemberId): Session | null {
      if (id === sender) return null;
      const target = sessions.peek(room)?.get(id);
      return target === undefined || target.owner ? null : target;
    },
    /**
     * Ended and unsubscribed first, so the target gets no frame before the close (ADR 0030 §2); a held
     * target has no socket, and its tokens die with the hold. The cooldown lives in the room's memory
     * only: never stored, logged or counted per address.
     */
    kick(room: Room, target: Session): void {
      if (target.client !== null) room.coolDown(target.client, wallNow() + KICK_COOLDOWN_MS, wallNow());
      const ws = target.ws;
      end(target, false);
      publish(room.topic, encode({ type: "member-left", memberId: target.memberId, reason: "kicked" }));
      if (ws !== null) closeWith(ws, CLOSE_CODES.KICKED, "kicked");
    },
    /** The room is going: every member ends, held ones too, revoking its tokens. */
    endAll(room: Room): void {
      for (const session of [...(sessions.peek(room)?.values() ?? [])]) end(session, true);
    },
    shareGrant: (room: Room, token: ShareToken): ShareGrant | undefined => grants.peek(room)?.get(token),
  };
}
