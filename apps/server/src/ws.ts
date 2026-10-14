import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
  CLOSE_CODES,
  EMOTE_BURST,
  EMOTE_REFILL_MS,
  KICK_COOLDOWN_MS,
  MAX_CLIENT_MESSAGE_BYTES,
  MODERATION_BURST,
  MODERATION_REFILL_MS,
  RESUME_GRACE_MS,
  ROOM_EDIT_BURST,
  ROOM_EDIT_REFILL_MS,
  parseClientMessage,
  type ClientMessage,
  type ControlPolicy,
  type ErrorCode,
  type MemberId,
  type ResumeToken,
  type RoomLayout,
  type ServerMessage,
  type ShareToken,
} from "@omega/shared";
import type { SecurityHeaders } from "./headers";
import { newShareGrant, plain, type ShareGrant } from "./http";
import { KeyedLimiter, TokenBucket, isLoopbackKey, monotonic, type Clock } from "./rate-limit";
import type { Queue, QueueActor, QueueAddRefusal, QueueRefusal } from "./queue";
import type { Room } from "./room";
import type { PerRoom, RoomRegistry } from "./rooms";
import { mintResumeToken, mintSecret } from "./secrets";

import { logError } from "./log";
import { Metrics, SERVICE_RESTART, type CountedClose } from "./metrics";

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

/** Per-member limiters: kept with the member through leave and rejoin on one socket, and through a grace hold. */
interface MemberBuckets {
  chat: TokenBucket;
  sit: TokenBucket;
  /** L2: `control` only, so seek wars stay bounded. */
  control: TokenBucket;
  /** Owner edits, `layout-set` and `title-set` together (ADR 0028 §6). */
  edit: TokenBucket;
  emote: TokenBucket;
  /** Owner moderation, `kick`, `mute` and `control-policy` together (ADR 0030 §1). */
  moderation: TokenBucket;
  /** `queue-add`, shared with `POST /rooms/:id/queue` through the share grant (ADR 0031 §2). */
  queue: TokenBucket;
}

/**
 * A joined member's identity (ADR 0043). It outlives its socket while held: an unexpected close of a
 * durable member keeps it for the grace window (`RESUME_GRACE_MS`), away, until a resume reattaches it or the hold expires.
 */
interface Session {
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
type Conn = ServerWebSocket<ConnData>;

// Rates are server-private (ADR 0016 §1); the numbers are the threat model's §6.
/** L1, per socket: bursts of 20 messages, 10/s sustained. Human pace; stops relay amplification. */
const WS_BURST = 20;
const WS_PER_SECOND = 10;
/** Per socket. */
const CHAT_BURST = 5;
export const CHAT_PER_SECOND = 1;
const SIT_BURST = 4;
const SIT_PER_SECOND = 1;
/** L2, per socket, `control` only: 4/s (docs/research/m1b-youtube-sync.md §6). */
export const CONTROL_BURST = 4;
const CONTROL_PER_SECOND = 4;
/** Per room, `control` from all its members together. */
export const ROOM_CONTROL_BURST = 8;
export const ROOM_CONTROL_PER_SECOND = 4;
/** Per client key: `join` attempts, and WebSocket upgrades (answered with HTTP 429). */
const JOIN_BURST = 6;
const JOIN_PER_SECOND = 0.2;
const UPGRADE_BURST = 10;
const UPGRADE_PER_SECOND = 0.5;
/**
 * Per client key: joins with a wrong owner token or a missing or wrong invite key (ADR 0028 §3, §4).
 * Tighter than the join limiter, so it binds: a real client never retries a wrong secret (tokens
 * don't rotate), it only sends what it stored.
 */
const FAILED_OWNER_BURST = 5;
const FAILED_OWNER_PER_SECOND = 1 / 30;
const FAILED_INVITE_BURST = 5;
const FAILED_INVITE_PER_SECOND = 1 / 30;
/** Escalation: close with CLOSE_CODES.RATE_LIMITED / BAD_MESSAGES. */
const MAX_DROPPED_IN_A_ROW = 50;
const MAX_BAD_MESSAGES = 20;
/** Bun closes a socket (1006) whose unsent data passes this, instead of buffering up to 16 MB. */
const BACKPRESSURE_LIMIT = 256 * 1024;
const IDLE_TIMEOUT_S = 60;
/** At most one `member-status` per member per this, trailing edge (ADR 0019 §3). */
const STATUS_INTERVAL_MS = 1000;

const encode = (msg: ServerMessage): string => JSON.stringify(msg);

/** Runs `run` after `ms`; returns its cancel. Tests inject one driven by their fake clock. */
export type Schedule = (run: () => void, ms: number) => () => void;
/** Never keeps the process alive. */
const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};
/** 16 random bytes, base64url without padding: 22 chars (ADR 0015). */
const mintShareToken = (): ShareToken => mintSecret();

interface WsDeps {
  /** Sockets that have not joined within this are closed. */
  joinTimeoutMs: number;
  /** Live rooms; their sockets and share grants are kept per room and end with it. */
  rooms: RoomRegistry;
  publish: (topic: string, data: string) => void;
  /** The socket closed: give its slot back to the upgrade gate (server.ts). */
  release: (ip: string) => void;
  /** Clock for every limiter. Default: monotonic `performance.now()`. */
  now?: Clock;
  /** `member-status` coalescing interval. Default STATUS_INTERVAL_MS; tests shorten it. */
  statusIntervalMs?: number;
  /** Security headers for the upgrade gate's own responses. */
  headers: SecurityHeaders;
  /** Writes an owner's edit through to the store; throws if it can't, and then nothing changes. */
  persistLayout: (room: Room, layout: RoomLayout) => void;
  persistTitle: (room: Room, title: string) => void;
  persistControlPolicy: (room: Room, policy: ControlPolicy) => void;
  /** ROOM_TITLE_BLOCKLIST, as `POST /rooms` applies it: a rename can't get round it. */
  titleBlocked: (title: string) => boolean;
  /** The room just went from 0 to 1 member or from 1 to 0 (room GC's `last_active_at`). Never per message. */
  occupancyChanged?: (room: Room) => void;
  /** Relay times and close counts for `GET /metrics` (OME-504). */
  metrics?: Metrics;
  /** Unix ms clock for seat holds after a restart. Default `Date.now`. */
  wallNow?: () => number;
  /** The playback queue (ADR 0031), shared with the HTTP `POST /rooms/:id/queue`. */
  queue: Queue;
  /** Whether a room id was taken down (ADR 0033 §5): its sockets close with TAKEN_DOWN, not ROOM_CLOSED. */
  takenDown?: (id: string) => boolean;
  /** Timers for grace-hold expiry (ADR 0043). Default `setTimeout`, unref'd. */
  schedule?: Schedule;
  /** How long a dropped durable member is held (ADR 0043). Default RESUME_GRACE_MS. */
  resumeGraceMs?: number;
}

interface Ws {
  /** Upgrade limiter, asked before the room lookup and the connection caps: a 429, or null to admit. */
  admitUpgrade: (ip: string) => Response | null;
  connData: (room: Room, ip: string) => ConnData;
  /** The grant `token` holds in `room`, if a member of that room holds it. */
  shareGrant: (room: Room, token: ShareToken) => ShareGrant | undefined;
  websocket: WebSocketHandler<ConnData>;
  /** Whether any socket, joined or still joining, is open on the room. */
  hasSockets: (room: Room) => boolean;
  /** Closes every socket with SERVICE_RESTART: clients reconnect on their own (graceful restart, OME-504). */
  closeAll: () => void;
}

export function createWs({
  joinTimeoutMs,
  rooms,
  publish,
  release,
  now = monotonic,
  statusIntervalMs = STATUS_INTERVAL_MS,
  headers,
  persistLayout,
  persistTitle,
  persistControlPolicy,
  titleBlocked,
  occupancyChanged = () => undefined,
  metrics = new Metrics(),
  wallNow = Date.now,
  queue,
  takenDown = () => false,
  schedule = realSchedule,
  resumeGraceMs = RESUME_GRACE_MS,
}: WsDeps): Ws {
  const upgrades = new KeyedLimiter(UPGRADE_BURST, UPGRADE_PER_SECOND, 1024, now);
  const joins = new KeyedLimiter(JOIN_BURST, JOIN_PER_SECOND, 1024, now);
  // Loopback peers too, like failed shares: a wrong secret is never local dev's normal path.
  const failedOwners = new KeyedLimiter(FAILED_OWNER_BURST, FAILED_OWNER_PER_SECOND, 1024, now);
  const failedInvites = new KeyedLimiter(FAILED_INVITE_BURST, FAILED_INVITE_PER_SECOND, 1024, now);
  const roomControls = rooms.perRoom(() => new TokenBucket(ROOM_CONTROL_BURST, ROOM_CONTROL_PER_SECOND, now));
  /** Every open socket on the room, joined or not, so `removeRoom` can close them. Dropped when empty. */
  const sockets = rooms.perRoom(() => new Set<Conn>());
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

  /** Every close the server sends goes through here, so `GET /metrics` counts it. */
  const closeWith = (ws: Conn, code: CountedClose, reason: string): void => {
    metrics.countClose(code);
    ws.close(code, reason);
  };

  const sendError = (ws: Conn, code: ErrorCode, message: string): void => {
    ws.send(encode({ type: "error", code, message }));
  };

  /** Counts a `bad_message`-like failure; closes with BAD_MESSAGES and returns false at the limit. */
  const countBad = (ws: Conn): boolean => {
    if (++ws.data.badMessages < MAX_BAD_MESSAGES) return true;
    closeWith(ws, CLOSE_CODES.BAD_MESSAGES, "too many bad messages");
    return false;
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

  /** Drops a frame: one notice per streak, and a close once the streak is MAX_DROPPED_IN_A_ROW long. */
  const refuse = (ws: Conn, retryAfterMs: number, message: string): void => {
    if (ws.data.dropped++ === 0) ws.send(encode({ type: "error", code: "rate_limited", message, retryAfterMs }));
    if (ws.data.dropped >= MAX_DROPPED_IN_A_ROW) closeWith(ws, CLOSE_CODES.RATE_LIMITED, "rate limited");
  };
  /** Passes `bucket`, or refuses the frame and returns false. */
  const admit = (ws: Conn, bucket: TokenBucket, message: string): boolean => {
    if (bucket.take()) return true;
    refuse(ws, bucket.retryAfterMs(), message);
    return false;
  };

  const armJoinTimer = (ws: Conn): void => {
    ws.data.joinTimer = setTimeout(() => {
      ws.data.joinTimer = null;
      if (ws.data.session === null) closeWith(ws, CLOSE_CODES.JOIN_TIMEOUT, "join timeout");
    }, joinTimeoutMs);
  };
  const clearJoinTimer = (ws: Conn): void => {
    if (ws.data.joinTimer !== null) clearTimeout(ws.data.joinTimer);
    ws.data.joinTimer = null;
  };

  /** Publishes the member's current `catching` if it differs from the last one published. */
  const flushStatus = (session: Session): void => {
    const { room, memberId, status } = session;
    status.timer = null;
    // The room keeps what was last published, so a server-side clear (embed switch) is seen here too.
    const catching = room.takeCatchingChange(memberId);
    if (catching === null) return;
    status.at = now();
    publish(room.topic, encode({ type: "member-status", memberId, catching }));
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

  /** Passes the frame's own limiters (L1 already passed), or refuses it and returns false. */
  const admitType = (ws: Conn, msg: ClientMessage): boolean => {
    switch (msg.type) {
      case "chat":
        return admit(ws, ws.data.buckets.chat, "too many chat messages, slow down");
      case "sit":
        return admit(ws, ws.data.buckets.sit, "too many seat changes, slow down");
      case "control": {
        // Refused in `handle`, before any bucket: a guest can't drain the room's control budget (ADR 0030 §4).
        if (ws.data.room.controlPolicy === "owner" && ws.data.session?.owner !== true) return true;
        if (!admit(ws, ws.data.buckets.control, "too many playback changes, slow down")) return false;
        // The room's limit is everyone's, not this sender's flood: a notice every time, and no streak (ADR 0018 §2).
        const roomBucket = roomControls.get(ws.data.room);
        if (roomBucket.take()) return true;
        ws.send(
          encode({
            type: "error",
            code: "rate_limited",
            message: "this room is changing playback too fast, slow down",
            retryAfterMs: roomBucket.retryAfterMs(),
          }),
        );
        return false;
      }
      case "join":
        if (!ws.data.keyed || joins.take(ws.data.ip)) return true;
        refuse(ws, joins.retryAfterMs(ws.data.ip), "too many joins, slow down");
        return false;
      case "layout-set":
      case "title-set":
        // Non-owners get not_owner (or not_joined) in `handle`; only the owner's edits take from the bucket.
        return ws.data.session?.owner !== true || admit(ws, ws.data.buckets.edit, "too many room edits, slow down");
      case "emote":
        // Unjoined sockets get not_joined in `handle`.
        return ws.data.session === null || admit(ws, ws.data.buckets.emote, "too many emotes, slow down");
      case "leave":
      case "ping":
      case "status":
      case "presence":
      case "kick":
      case "mute":
      case "control-policy":
      // The queue's add buckets come after its control-policy check, in `handle` (ADR 0031 §3).
      case "queue-add":
      case "queue-remove":
      case "queue-advance":
      case "ended":
        return true;
    }
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

  const handle = (ws: Conn, msg: ClientMessage): void => {
    const { room, session } = ws.data;
    if (msg.type === "ping") {
      // Clock sample: sender only, allowed before join. The token bucket already counted it.
      ws.send(encode({ type: "pong", id: msg.id, at: Date.now() }));
      return;
    }
    if (msg.type === "join") {
      if (session !== null) {
        sendError(ws, "already_joined", "already joined");
        return;
      }
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
      return;
    }
    if (msg.type === "ended") {
      // Reports what a player saw: never an error, not even before join (ADR 0031 §4).
      if (session !== null) queue.ended(room, msg.itemId, msg.position);
      return;
    }
    if (session === null) {
      sendError(ws, "not_joined", "join first");
      return;
    }
    const { memberId } = session;
    switch (msg.type) {
      case "presence":
        // A hint, published on transitions only: it never starts, extends or ends a hold (ADR 0043).
        if (room.setAway(memberId, msg.away)) publish(room.topic, encode({ type: "member-presence", memberId, away: msg.away }));
        return;
      case "leave":
        // Explicit: no grace, both tokens die now.
        end(session, false);
        publish(room.topic, encode({ type: "member-left", memberId }));
        armJoinTimer(ws);
        return;
      case "sit":
        if (room.sit(memberId, msg.seat) === "seat_taken") {
          sendError(ws, "seat_taken", "seat is taken");
          return;
        }
        publish(room.topic, encode({ type: "seat-changed", memberId, seat: msg.seat }));
        return;
      case "chat":
        if (room.isMuted(memberId)) {
          sendError(ws, "muted", "the room's owner muted you");
          return;
        }
        publish(room.topic, encode({ type: "chat", memberId, text: msg.text, at: Date.now() }));
        return;
      case "control": {
        if (room.controlPolicy === "owner" && !session.owner) {
          sendError(ws, "control_owner_only", "only the room's owner controls playback here");
          return;
        }
        const playback = room.control(memberId, msg);
        if (playback === null) {
          sendError(ws, "no_embed", "that video is not playing here");
          return;
        }
        publish(room.topic, encode({ type: "playback", playback }));
        return;
      }
      case "status": {
        // Catching up means nothing without sync (ADR 0024 §7).
        if (room.hasGenericEmbed()) return;
        // State, not an event: store it, publish on change, at most once per interval per member.
        room.setCatching(memberId, msg.catching);
        const status = session.status;
        if (status.timer !== null) return;
        const wait = status.at + statusIntervalMs - now();
        if (wait <= 0) flushStatus(session);
        else status.timer = setTimeout(flushStatus, wait, session);
        return;
      }
      case "layout-set":
      case "title-set":
        if (!session.owner) {
          sendError(ws, "not_owner", "only the room's owner can do that");
          countBad(ws);
          return;
        }
        if (msg.type === "layout-set") setLayout(room, memberId, msg.layout);
        else setTitle(ws, room, memberId, msg.title);
        return;
      case "emote":
        // Fire-and-forget: never stored, never in a snapshot.
        publish(room.topic, encode({ type: "emoted", memberId, kind: msg.kind }));
        return;
      case "kick":
      case "mute":
      case "control-policy":
        // ADR 0030 §1: owner, then the moderation bucket, then the target; nothing is written before all three pass.
        if (!session.owner) {
          sendError(ws, "not_owner", "only the room's owner can do that");
          countBad(ws);
          return;
        }
        if (!admit(ws, ws.data.buckets.moderation, "too many moderation actions, slow down")) return;
        if (msg.type === "control-policy") {
          setControlPolicy(room, memberId, msg.policy);
          return;
        }
        {
          const target = targetOf(room, memberId, msg.memberId);
          if (target === null) {
            // A race with someone leaving is normal: not counted toward 4400.
            sendError(ws, "bad_target", "no such member to moderate");
            return;
          }
          if (msg.type === "kick") kick(room, target);
          else if (room.setMuted(msg.memberId, msg.muted)) {
            publish(room.topic, encode({ type: "member-muted", memberId: msg.memberId, muted: msg.muted }));
          }
        }
        return;
      case "queue-add": {
        const actor = actorOf(session);
        const refused = queue.admit(room, actor);
        const added = refused ?? queue.add(room, actor, msg.url);
        if ("code" in added) queueRefused(ws, added);
        return;
      }
      case "queue-remove":
      case "queue-advance": {
        const actor = actorOf(session);
        const refused = msg.type === "queue-remove" ? queue.remove(room, actor, msg.itemId) : queue.advance(room, actor, msg.fromItemId);
        if (refused !== null) queueRefused(ws, refused);
        return;
      }
    }
  };

  const actorOf = (session: Session): QueueActor => ({ memberId: session.memberId, owner: session.owner, addBucket: session.buckets.queue });

  /** None of these counts toward the 4400 close (ADR 0031 §3). A failed store write says nothing, as for owner edits. */
  const queueRefused = (ws: Conn, refused: QueueRefusal | QueueAddRefusal): void => {
    switch (refused.code) {
      case "control_owner_only":
        sendError(ws, "control_owner_only", "only the room's owner changes the queue here");
        return;
      case "rate_limited":
        ws.send(encode({ type: "error", code: "rate_limited", message: "too many videos queued, slow down", retryAfterMs: refused.retryAfterMs }));
        return;
      case "unsupported_url":
        sendError(ws, "unsupported_url", "not a supported video URL");
        return;
      case "queue_full":
        sendError(ws, "queue_full", "the queue is full");
        return;
      case "unavailable":
        return;
    }
  };

  /** The guest member `id` names in `room`, live or held (ADR 0043): not the sender, not owner-joined. */
  const targetOf = (room: Room, sender: MemberId, id: MemberId): Session | null => {
    if (id === sender) return null;
    const target = sessions.peek(room)?.get(id);
    return target === undefined || target.owner ? null : target;
  };

  /**
   * Ended and unsubscribed first, so the target gets no frame before the close (ADR 0030 §2); a held
   * target has no socket, and its tokens die with the hold. The cooldown lives in the room's memory
   * only: never stored, logged or counted per address.
   */
  const kick = (room: Room, target: Session): void => {
    if (target.client !== null) room.coolDown(target.client, wallNow() + KICK_COOLDOWN_MS, wallNow());
    const ws = target.ws;
    end(target, false);
    publish(room.topic, encode({ type: "member-left", memberId: target.memberId, reason: "kicked" }));
    if (ws !== null) closeWith(ws, CLOSE_CODES.KICKED, "kicked");
  };

  /** Store first: if the write fails nothing changes, so memory never runs ahead of the DB. */
  const persisted = (event: "store.layout" | "store.title" | "store.control_policy", write: () => void): boolean => {
    try {
      write();
      return true;
    } catch (err) {
      logError(event, err);
      return false;
    }
  };
  /** Last write wins; seats keep their indices, so nobody is unseated (ADR 0028 §6). */
  const setLayout = (room: Room, by: MemberId, layout: RoomLayout): void => {
    if (JSON.stringify(layout) === JSON.stringify(room.layout)) return;
    if (!persisted("store.layout", () => {
      persistLayout(room, layout);
    })) return;
    room.setLayout(layout);
    publish(room.topic, encode({ type: "layout-changed", layout, by }));
  };
  const setTitle = (ws: Conn, room: Room, by: MemberId, title: string): void => {
    if (title === room.title) return;
    if (titleBlocked(title)) {
      // A valid frame, so it doesn't count toward 4400; the contract has no closer code.
      sendError(ws, "bad_message", "that title isn't allowed");
      return;
    }
    if (!persisted("store.title", () => {
      persistTitle(room, title);
    })) return;
    room.setTitle(title);
    publish(room.topic, encode({ type: "title-changed", title, by }));
  };

  const setControlPolicy = (room: Room, by: MemberId, policy: ControlPolicy): void => {
    if (policy === room.controlPolicy) return;
    if (!persisted("store.control_policy", () => {
      persistControlPolicy(room, policy);
    })) return;
    room.setControlPolicy(policy);
    publish(room.topic, encode({ type: "control-policy-changed", policy, by }));
  };

  // The room is already unregistered: every member ends, held ones too, revoking its tokens, then the sockets close.
  // No `member-left` per member: every socket closes with ROOM_CLOSED (or TAKEN_DOWN), which says it all.
  rooms.onRemove((room, reason) => {
    for (const session of [...(sessions.peek(room)?.values() ?? [])]) end(session, true);
    const open = sockets.peek(room);
    if (open === undefined) return;
    for (const ws of [...open]) {
      clearJoinTimer(ws);
      if (reason === "taken_down") closeWith(ws, CLOSE_CODES.TAKEN_DOWN, "room taken down");
      else closeWith(ws, CLOSE_CODES.ROOM_CLOSED, "room closed");
    }
  });

  return {
    closeAll() {
      for (const room of rooms.values()) {
        for (const ws of [...(sockets.peek(room) ?? [])]) {
          clearJoinTimer(ws);
          closeWith(ws, SERVICE_RESTART, "server restarting");
        }
      }
    },
    shareGrant: (room, token) => grants.peek(room)?.get(token),
    hasSockets: (room) => sockets.peek(room) !== undefined,
    admitUpgrade(ip) {
      if (isLoopbackKey(ip) || upgrades.take(ip)) return null;
      const res = plain(429, "reconnecting too fast", headers);
      res.headers.set("retry-after", String(Math.ceil(upgrades.retryAfterMs(ip) / 1000)));
      return res;
    },
    connData: (room, ip) => ({
      room,
      ip,
      keyed: !isLoopbackKey(ip),
      session: null,
      bucket: new TokenBucket(WS_BURST, WS_PER_SECOND, now),
      buckets: {
        chat: new TokenBucket(CHAT_BURST, CHAT_PER_SECOND, now),
        sit: new TokenBucket(SIT_BURST, SIT_PER_SECOND, now),
        control: new TokenBucket(CONTROL_BURST, CONTROL_PER_SECOND, now),
        edit: new TokenBucket(ROOM_EDIT_BURST, 1000 / ROOM_EDIT_REFILL_MS, now),
        emote: new TokenBucket(EMOTE_BURST, 1000 / EMOTE_REFILL_MS, now),
        moderation: new TokenBucket(MODERATION_BURST, 1000 / MODERATION_REFILL_MS, now),
        queue: queue.memberBucket(),
      },
      dropped: 0,
      badMessages: 0,
      joinTimer: null,
    }),
    websocket: {
      maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
      backpressureLimit: BACKPRESSURE_LIMIT,
      closeOnBackpressureLimit: true,
      idleTimeout: IDLE_TIMEOUT_S,
      sendPings: true,
      open(ws) {
        // Upgraded as its room went, or to a taken-down id (ADR 0033 §5): closed before any snapshot.
        if (!rooms.has(ws.data.room)) {
          if (takenDown(ws.data.room.id)) closeWith(ws, CLOSE_CODES.TAKEN_DOWN, "room taken down");
          else closeWith(ws, CLOSE_CODES.ROOM_CLOSED, "room closed");
          return;
        }
        sockets.get(ws.data.room).add(ws);
        armJoinTimer(ws);
      },
      message(ws, raw) {
        const t0 = performance.now();
        if (!admit(ws, ws.data.bucket, "too many messages, slow down")) return;
        const msg = typeof raw === "string" ? parseClientMessage(raw) : null;
        if (msg === null) {
          sendError(ws, "bad_message", "invalid message");
          countBad(ws);
          return;
        }
        if (!admitType(ws, msg)) return;
        ws.data.dropped = 0;
        handle(ws, msg);
        metrics.observeRelay(performance.now() - t0);
      },
      close(ws) {
        clearJoinTimer(ws);
        const open = sockets.peek(ws.data.room);
        if (open !== undefined && open.delete(ws) && open.size === 0) sockets.drop(ws.data.room);
        release(ws.data.ip);
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
    },
  };
}
