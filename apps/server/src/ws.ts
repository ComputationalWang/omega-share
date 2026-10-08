import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
  CLOSE_CODES,
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type MemberId,
  type ServerMessage,
  type ShareToken,
} from "@omega/shared";
import type { SecurityHeaders } from "./headers";
import { newShareGrant, plain, type ShareGrant } from "./http";
import { KeyedLimiter, TokenBucket, isLoopbackKey, monotonic, type Clock } from "./rate-limit";
import type { Room } from "./room";
import type { RoomRegistry } from "./rooms";
import { mintSecret } from "./secrets";

export interface ConnData {
  room: Room;
  /** Client key (ADR 0015 §5). */
  ip: string;
  /** False for loopback peers, which skip the per-key limits (join limiter, members per key). */
  keyed: boolean;
  memberId: MemberId | null;
  /** Authorizes this member's shares while joined; only ever sent to this socket. */
  shareToken: ShareToken | null;
  /** L1: every frame. */
  bucket: TokenBucket;
  chatBucket: TokenBucket;
  sitBucket: TokenBucket;
  /** L2: `control` only, so seek wars stay bounded. */
  controlBucket: TokenBucket;
  /** Frames dropped in a row by any limiter. The first of a streak gets the one `rate_limited` notice. */
  dropped: number;
  /** `bad_message`s over the socket's life. */
  badMessages: number;
  joinTimer: Timer | null;
  /** `member-status` coalescing for this socket's member (ADR 0019 §3). */
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
/** Escalation: close with CLOSE_CODES.RATE_LIMITED / BAD_MESSAGES. */
const MAX_DROPPED_IN_A_ROW = 50;
const MAX_BAD_MESSAGES = 20;
/** Bun closes a socket (1006) whose unsent data passes this, instead of buffering up to 16 MB. */
const BACKPRESSURE_LIMIT = 256 * 1024;
const IDLE_TIMEOUT_S = 60;
/** At most one `member-status` per member per this, trailing edge (ADR 0019 §3). */
const STATUS_INTERVAL_MS = 1000;

const encode = (msg: ServerMessage): string => JSON.stringify(msg);
/** 16 random bytes, base64url without padding: 22 chars (ADR 0015). */
const mintShareToken = (): ShareToken => mintSecret();

export interface WsDeps {
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
}

export interface Ws {
  /** Upgrade limiter, asked before the room lookup and the connection caps: a 429, or null to admit. */
  admitUpgrade: (ip: string) => Response | null;
  connData: (room: Room, ip: string) => ConnData;
  /** The grant `token` holds in `room`, if a member of that room holds it. */
  shareGrant: (room: Room, token: ShareToken) => ShareGrant | undefined;
  websocket: WebSocketHandler<ConnData>;
}

export function createWs({
  joinTimeoutMs,
  rooms,
  publish,
  release,
  now = monotonic,
  statusIntervalMs = STATUS_INTERVAL_MS,
  headers,
}: WsDeps): Ws {
  const upgrades = new KeyedLimiter(UPGRADE_BURST, UPGRADE_PER_SECOND, 1024, now);
  const joins = new KeyedLimiter(JOIN_BURST, JOIN_PER_SECOND, 1024, now);
  const roomControls = rooms.perRoom(() => new TokenBucket(ROOM_CONTROL_BURST, ROOM_CONTROL_PER_SECOND, now));
  /** Every open socket on the room, joined or not, so `removeRoom` can close them. Dropped when empty. */
  const sockets = rooms.perRoom(() => new Set<Conn>());
  /** Share tokens of the room's joined members. Dropped when empty. */
  const grants = rooms.perRoom(() => new Map<ShareToken, ShareGrant>());

  const sendError = (ws: Conn, code: ErrorCode, message: string): void => {
    ws.send(encode({ type: "error", code, message }));
  };

  /** Drops a frame: one notice per streak, and a close once the streak is MAX_DROPPED_IN_A_ROW long. */
  const refuse = (ws: Conn, retryAfterMs: number, message: string): void => {
    if (ws.data.dropped++ === 0) ws.send(encode({ type: "error", code: "rate_limited", message, retryAfterMs }));
    if (ws.data.dropped >= MAX_DROPPED_IN_A_ROW) ws.close(CLOSE_CODES.RATE_LIMITED, "rate limited");
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
      if (ws.data.memberId === null) ws.close(CLOSE_CODES.JOIN_TIMEOUT, "join timeout");
    }, joinTimeoutMs);
  };
  const clearJoinTimer = (ws: Conn): void => {
    if (ws.data.joinTimer !== null) clearTimeout(ws.data.joinTimer);
    ws.data.joinTimer = null;
  };

  /** Publishes the member's current `catching` if it differs from the last one published. */
  const flushStatus = (ws: Conn, memberId: MemberId): void => {
    const status = ws.data.status;
    status.timer = null;
    // The room keeps what was last published, so a server-side clear (embed switch) is seen here too.
    const catching = ws.data.room.takeCatchingChange(memberId);
    if (catching === null) return;
    status.at = now();
    publish(ws.data.room.topic, encode({ type: "member-status", memberId, catching }));
  };

  const depart = (ws: Conn, memberId: MemberId, closing: boolean): void => {
    ws.data.memberId = null;
    // The flag leaves with the member: `member-left` says it all (ADR 0019 §3).
    if (ws.data.status.timer !== null) clearTimeout(ws.data.status.timer);
    ws.data.status = freshStatus();
    const held = grants.peek(ws.data.room);
    if (held !== undefined && ws.data.shareToken !== null) {
      held.delete(ws.data.shareToken);
      if (held.size === 0) grants.drop(ws.data.room);
    }
    ws.data.shareToken = null;
    ws.data.room.leave(memberId);
    if (!closing) ws.unsubscribe(ws.data.room.topic);
    publish(ws.data.room.topic, encode({ type: "member-left", memberId }));
  };

  /** Passes the frame's own limiters (L1 already passed), or refuses it and returns false. */
  const admitType = (ws: Conn, msg: ClientMessage): boolean => {
    switch (msg.type) {
      case "chat":
        return admit(ws, ws.data.chatBucket, "too many chat messages, slow down");
      case "sit":
        return admit(ws, ws.data.sitBucket, "too many seat changes, slow down");
      case "control": {
        if (!admit(ws, ws.data.controlBucket, "too many playback changes, slow down")) return false;
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
      case "leave":
      case "ping":
      case "status":
      case "layout-set":
      case "title-set":
        return true;
    }
  };

  const handle = (ws: Conn, msg: ClientMessage): void => {
    const { room, memberId } = ws.data;
    if (msg.type === "ping") {
      // Clock sample: sender only, allowed before join. The token bucket already counted it.
      ws.send(encode({ type: "pong", id: msg.id, at: Date.now() }));
      return;
    }
    if (msg.type === "join") {
      if (memberId !== null) {
        sendError(ws, "already_joined", "already joined");
        return;
      }
      const joined = room.join(msg.nickname, msg.avatar, ws.data.keyed ? ws.data.ip : null);
      if (!joined.ok) {
        if (joined.reason === "room_full") {
          ws.send(encode({ type: "room-full" }));
          ws.close(CLOSE_CODES.ROOM_FULL, "room full");
        } else if (joined.reason === "nickname_taken") {
          sendError(ws, "nickname_taken", "that name is taken in this room");
        } else {
          sendError(ws, "too_many_members", "too many members from your address in this room");
        }
        return;
      }
      const member = joined.member;
      clearJoinTimer(ws);
      ws.data.memberId = member.id;
      const shareToken = mintShareToken();
      ws.data.shareToken = shareToken;
      grants.get(room).set(shareToken, newShareGrant(member.id));
      ws.send(encode({ type: "snapshot", self: member.id, room: room.snapshot(), shareToken }));
      ws.subscribe(room.topic);
      ws.publish(room.topic, encode({ type: "member-joined", member }));
      return;
    }
    if (memberId === null) {
      sendError(ws, "not_joined", "join first");
      return;
    }
    switch (msg.type) {
      case "leave":
        depart(ws, memberId, false);
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
        publish(room.topic, encode({ type: "chat", memberId, text: msg.text, at: Date.now() }));
        return;
      case "control": {
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
        const status = ws.data.status;
        if (status.timer !== null) return;
        const wait = status.at + statusIntervalMs - now();
        if (wait <= 0) flushStatus(ws, memberId);
        else status.timer = setTimeout(flushStatus, wait, ws, memberId);
        return;
      }
      case "layout-set":
      case "title-set":
        // Nobody joins as the owner until created rooms land (ADR 0028).
        sendError(ws, "not_owner", "only the room's owner can do that");
        return;
    }
  };

  // The room is already unregistered: depart revokes each member's grant, then the socket closes.
  rooms.onRemove((room) => {
    const open = sockets.peek(room);
    if (open === undefined) return;
    for (const ws of [...open]) {
      clearJoinTimer(ws);
      if (ws.data.memberId !== null) depart(ws, ws.data.memberId, true);
      ws.close(CLOSE_CODES.ROOM_CLOSED, "room closed");
    }
  });

  return {
    shareGrant: (room, token) => grants.peek(room)?.get(token),
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
      memberId: null,
      shareToken: null,
      bucket: new TokenBucket(WS_BURST, WS_PER_SECOND, now),
      chatBucket: new TokenBucket(CHAT_BURST, CHAT_PER_SECOND, now),
      sitBucket: new TokenBucket(SIT_BURST, SIT_PER_SECOND, now),
      controlBucket: new TokenBucket(CONTROL_BURST, CONTROL_PER_SECOND, now),
      dropped: 0,
      badMessages: 0,
      joinTimer: null,
      status: freshStatus(),
    }),
    websocket: {
      maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
      backpressureLimit: BACKPRESSURE_LIMIT,
      closeOnBackpressureLimit: true,
      idleTimeout: IDLE_TIMEOUT_S,
      sendPings: true,
      open(ws) {
        // Upgraded as its room went.
        if (!rooms.has(ws.data.room)) {
          ws.close(CLOSE_CODES.ROOM_CLOSED, "room closed");
          return;
        }
        sockets.get(ws.data.room).add(ws);
        armJoinTimer(ws);
      },
      message(ws, raw) {
        if (!admit(ws, ws.data.bucket, "too many messages, slow down")) return;
        const msg = typeof raw === "string" ? parseClientMessage(raw) : null;
        if (msg === null) {
          sendError(ws, "bad_message", "invalid message");
          if (++ws.data.badMessages >= MAX_BAD_MESSAGES) ws.close(CLOSE_CODES.BAD_MESSAGES, "too many bad messages");
          return;
        }
        if (!admitType(ws, msg)) return;
        ws.data.dropped = 0;
        handle(ws, msg);
      },
      close(ws) {
        clearJoinTimer(ws);
        const open = sockets.peek(ws.data.room);
        if (open !== undefined && open.delete(ws) && open.size === 0) sockets.drop(ws.data.room);
        release(ws.data.ip);
        if (ws.data.memberId !== null) depart(ws, ws.data.memberId, true);
      },
    },
  };
}
