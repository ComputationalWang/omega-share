import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type MemberId,
  type ServerMessage,
  type ShareToken,
} from "@omega/shared";
import { newShareGrant, type ShareGrant } from "./http";
import { TokenBucket } from "./rate-limit";
import type { Room } from "./room";

export interface ConnData {
  room: Room;
  ip: string;
  memberId: MemberId | null;
  /** Authorizes this member's shares while joined; only ever sent to this socket. */
  shareToken: ShareToken | null;
  bucket: TokenBucket;
  /** Already told this socket it is rate limited; stay quiet until it slows down. */
  limited: boolean;
  /** `control` only, on top of `bucket`, so seek wars stay bounded. */
  controlBucket: TokenBucket;
  controlLimited: boolean;
  joinTimer: Timer | null;
}
type Conn = ServerWebSocket<ConnData>;

/** Per socket: bursts of 20 messages, 10/s sustained. Human pace; stops relay amplification. */
const WS_BURST = 20;
const WS_PER_SECOND = 10;
/** Per socket, `control` only: 4/s (docs/research/m1b-youtube-sync.md §6). */
const CONTROL_BURST = 4;
const CONTROL_PER_SECOND = 4;

const encode = (msg: ServerMessage): string => JSON.stringify(msg);
/** 16 random bytes, base64url without padding: 22 chars (ADR 0015). */
const mintShareToken = (): ShareToken => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

export interface WsDeps {
  /** Sockets that have not joined within this are closed. */
  joinTimeoutMs: number;
  shareGrants: Map<ShareToken, ShareGrant>;
  publish: (topic: string, data: string) => void;
  /** The socket closed: give its slot back to the upgrade gate (server.ts). */
  release: (ip: string) => void;
}

export interface Ws {
  /**
   * Upgrade limiter hook, asked after the connection caps and before the upgrade: a refusal, or null to
   * admit. Stub until the WS hardening issue (OME-187) fills it in.
   */
  admitUpgrade: (ip: string) => Response | null;
  connData: (room: Room, ip: string) => ConnData;
  websocket: WebSocketHandler<ConnData>;
}

export function createWs({ joinTimeoutMs, shareGrants, publish, release }: WsDeps): Ws {
  const sendError = (ws: Conn, code: ErrorCode, message: string): void => {
    ws.send(encode({ type: "error", code, message }));
  };

  const armJoinTimer = (ws: Conn): void => {
    ws.data.joinTimer = setTimeout(() => {
      ws.data.joinTimer = null;
      if (ws.data.memberId === null) ws.close(1008, "join timeout");
    }, joinTimeoutMs);
  };
  const clearJoinTimer = (ws: Conn): void => {
    if (ws.data.joinTimer !== null) clearTimeout(ws.data.joinTimer);
    ws.data.joinTimer = null;
  };

  const depart = (ws: Conn, memberId: MemberId, closing: boolean): void => {
    ws.data.memberId = null;
    if (ws.data.shareToken !== null) shareGrants.delete(ws.data.shareToken);
    ws.data.shareToken = null;
    ws.data.room.leave(memberId);
    if (!closing) ws.unsubscribe(ws.data.room.topic);
    publish(ws.data.room.topic, encode({ type: "member-left", memberId }));
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
      const member = room.join(msg.nickname, msg.avatar);
      if (member === null) {
        ws.send(encode({ type: "room-full" }));
        ws.close(1008, "room full");
        return;
      }
      clearJoinTimer(ws);
      ws.data.memberId = member.id;
      const shareToken = mintShareToken();
      ws.data.shareToken = shareToken;
      shareGrants.set(shareToken, newShareGrant(room, member.id));
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
        if (!ws.data.controlBucket.take()) {
          if (!ws.data.controlLimited) sendError(ws, "rate_limited", "too many playback changes, slow down");
          ws.data.controlLimited = true;
          return;
        }
        ws.data.controlLimited = false;
        const playback = room.control(memberId, msg);
        if (playback === null) {
          sendError(ws, "no_embed", "that video is not playing here");
          return;
        }
        publish(room.topic, encode({ type: "playback", playback }));
        return;
      }
    }
  };

  return {
    admitUpgrade: () => null,
    connData: (room, ip) => ({
      room,
      ip,
      memberId: null,
      shareToken: null,
      bucket: new TokenBucket(WS_BURST, WS_PER_SECOND),
      limited: false,
      controlBucket: new TokenBucket(CONTROL_BURST, CONTROL_PER_SECOND),
      controlLimited: false,
      joinTimer: null,
    }),
    websocket: {
      maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
      open(ws) {
        armJoinTimer(ws);
      },
      message(ws, raw) {
        if (!ws.data.bucket.take()) {
          if (!ws.data.limited) sendError(ws, "rate_limited", "too many messages, slow down");
          ws.data.limited = true;
          return;
        }
        ws.data.limited = false;
        const msg = typeof raw === "string" ? parseClientMessage(raw) : null;
        if (msg === null) {
          sendError(ws, "bad_message", "invalid message");
          return;
        }
        handle(ws, msg);
      },
      close(ws) {
        clearJoinTimer(ws);
        release(ws.data.ip);
        if (ws.data.memberId !== null) depart(ws, ws.data.memberId, true);
      },
    },
  };
}
