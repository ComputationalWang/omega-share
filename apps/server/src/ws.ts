import type { WebSocketHandler } from "bun";
import {
  CLOSE_CODES,
  MAX_CLIENT_MESSAGE_BYTES,
  RESUME_GRACE_MS,
  parseClientMessage,
  type ClientMessage,
  type ControlPolicy,
  type ErrorCode,
  type RoomLayout,
  type ServerMessage,
  type ShareToken,
} from "@omega/shared";
import type { SecurityHeaders } from "./headers";
import { plain, type ShareGrant } from "./http";
import { KeyedLimiter, TokenBucket, isLoopbackKey, monotonic, type Clock } from "./rate-limit";
import type { Queue, QueueActor, QueueAddRefusal, QueueRefusal } from "./queue";
import type { Room } from "./room";
import type { RoomRegistry } from "./rooms";
import { Metrics, SERVICE_RESTART, type CountedClose } from "./metrics";
import {
  BACKPRESSURE_LIMIT,
  IDLE_TIMEOUT_S,
  JOIN_BURST,
  JOIN_PER_SECOND,
  MAX_BAD_MESSAGES,
  MAX_DROPPED_IN_A_ROW,
  ROOM_CONTROL_BURST,
  ROOM_CONTROL_PER_SECOND,
  STATUS_INTERVAL_MS,
  UPGRADE_BURST,
  UPGRADE_PER_SECOND,
  WS_BURST,
  WS_PER_SECOND,
  newMemberBuckets,
} from "./ws-limits";
import { createOwnerEdits } from "./ws-owner-edits";
import { createSessions, realSchedule, type Conn, type ConnData, type Schedule, type Session } from "./ws-sessions";

export { CHAT_PER_SECOND, CONTROL_BURST, ROOM_CONTROL_BURST, ROOM_CONTROL_PER_SECOND } from "./ws-limits";
export type { ConnData, Schedule } from "./ws-sessions";

const encode = (msg: ServerMessage): string => JSON.stringify(msg);

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
  const roomControls = rooms.perRoom(() => new TokenBucket(ROOM_CONTROL_BURST, ROOM_CONTROL_PER_SECOND, now));
  /** Every open socket on the room, joined or not, so `removeRoom` can close them. Dropped when empty. */
  const sockets = rooms.perRoom(() => new Set<Conn>());

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

  const sessions = createSessions({ rooms, publish, now, wallNow, schedule, resumeGraceMs, occupancyChanged, closeWith, countBad, clearJoinTimer });
  const edits = createOwnerEdits({ publish, persistLayout, persistTitle, persistControlPolicy, titleBlocked });

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
      case "queue-move":
      case "queue-advance":
      case "ended":
      case "walk":
      case "set-tint":
      case "set-accessory":
      case "typing":
      case "roll":
        return true;
    }
  };

  const handle = (ws: Conn, msg: ClientMessage): void => {
    const { room, session } = ws.data;
    if (msg.type === "ping") {
      // Clock sample: sender only, allowed before join. The token bucket already counted it.
      ws.send(encode({ type: "pong", id: msg.id, at: Date.now() }));
      return;
    }
    if (msg.type === "join") {
      if (session !== null) sendError(ws, "already_joined", "already joined");
      else sessions.join(ws, msg);
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
        sessions.leave(session);
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
        if (msg.type === "layout-set") edits.setLayout(room, memberId, msg.layout);
        else edits.setTitle(ws, room, memberId, msg.title);
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
          edits.setControlPolicy(room, memberId, msg.policy);
          return;
        }
        {
          const target = sessions.targetOf(room, memberId, msg.memberId);
          if (target === null) {
            // A race with someone leaving is normal: not counted toward 4400.
            sendError(ws, "bad_target", "no such member to moderate");
            return;
          }
          if (msg.type === "kick") sessions.kick(room, target);
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
      // OME-1249 came after the Rust switch: the frozen TS server (rollback only) ignores reorders.
      case "queue-move":
        return;
      // OME-1346 (ADR 0053) came after the Rust switch too: the frozen TS server ignores walks and tints.
      case "walk":
      case "set-tint":
      // OME-1387 too: the frozen TS server ignores accessories and typing.
      case "set-accessory":
      case "typing":
      // OME-1423 too: the frozen TS server ignores rolls (and has no own-room door check).
      case "roll":
        return;
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

  // The room is already unregistered: every member ends, held ones too, revoking its tokens, then the sockets close.
  // No `member-left` per member: every socket closes with ROOM_CLOSED (or TAKEN_DOWN), which says it all.
  rooms.onRemove((room, reason) => {
    sessions.endAll(room);
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
    shareGrant: sessions.shareGrant,
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
      buckets: newMemberBuckets(queue.memberBucket(), now),
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
        sessions.closed(ws);
      },
    },
  };
}
