import type { Server, ServerWebSocket } from "bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as v from "valibot";
import {
  DEFAULT_ROOM_ID,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_LISTED_ROOMS,
  ShareRequestSchema,
  canonicalizeEmbed,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type MemberId,
  type RoomListResponse,
  type ServerMessage,
  type ShareErrorCode,
  type ShareResponse,
} from "@omega/shared";
import { KeyedLimiter, TokenBucket, addressKey, readBodyCapped } from "./rate-limit";
import { Room } from "./room";

export interface ServerOptions {
  port: number;
  hostname?: string;
  /** The site's origin, e.g. `http://localhost:5173`. Only it and extension origins may call the API. */
  siteOrigin: string;
  /** Sockets that have not joined within this are closed. Default 10 s. */
  joinTimeoutMs?: number;
  /** Open WebSockets allowed per client address. Default 50. */
  maxConnectionsPerIp?: number;
}

interface ConnData {
  room: Room;
  ip: string;
  memberId: MemberId | null;
  bucket: TokenBucket;
  /** Already told this socket it is rate limited; stay quiet until it slows down. */
  limited: boolean;
  joinTimer: Timer | null;
}
type Conn = ServerWebSocket<ConnData>;

/** Share bodies are `{ url }` with url ≤ 2048 chars; anything bigger is refused unread. */
const MAX_SHARE_BODY_BYTES = 4096;
/** Per socket: bursts of 20 messages, 10/s sustained. Human pace; stops relay amplification. */
const WS_BURST = 20;
const WS_PER_SECOND = 10;
/** Per address: 5 shares at once, then one every 3 s. */
const SHARE_BURST = 5;
const SHARE_PER_SECOND = 1 / 3;
const WS_PATH = /^\/rooms\/([^/]+)\/ws$/;
/** Any Chromium extension id. Pin to our published id once it exists (see README). */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

const encode = (msg: ServerMessage): string => JSON.stringify(msg);

export function startServer(opts: ServerOptions): Server<ConnData> {
  const joinTimeoutMs = opts.joinTimeoutMs ?? 10_000;
  const maxConnectionsPerIp = opts.maxConnectionsPerIp ?? 50;
  const rooms = new Map<string, Room>([[DEFAULT_ROOM_ID, new Room(DEFAULT_ROOM_ID)]]);
  const connectionsPerIp = new Map<string, number>();
  const shareLimiter = new KeyedLimiter(SHARE_BURST, SHARE_PER_SECOND);

  const isAllowedOrigin = (origin: string): boolean => origin === opts.siteOrigin || EXTENSION_ORIGIN.test(origin);
  /** Browsers always send Origin; non-browser clients may omit it and are not a CSRF vector. */
  const originOk = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    return origin === null || isAllowedOrigin(origin);
  };
  /** The socket peer: expose the server directly, since behind a proxy every user shares one key (README). */
  const ipOf = (req: Request): string => addressKey(server.requestIP(req)?.address ?? "unknown");

  const app = new Hono();
  app.use(
    "/rooms/*",
    cors({
      origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
      allowMethods: ["GET", "POST"],
      allowHeaders: ["content-type"],
      maxAge: 600,
    }),
  );

  /** Readiness probe (Playwright webServer, supervisors). */
  app.get("/", (c) => c.text("omega-share server"));

  app.get("/rooms", (c) => {
    const listed = [...rooms.values()].slice(0, MAX_LISTED_ROOMS);
    const body: RoomListResponse = { rooms: listed.map((r) => r.summary()) };
    return c.json(body);
  });

  app.post("/rooms/:id/share", async (c) => {
    const fail = (status: 400 | 404 | 413 | 429, code: ShareErrorCode, message: string) => {
      const body: ShareResponse = { ok: false, error: { code, message } };
      return c.json(body, status);
    };
    // Not a ShareResponse: the contract has no code for it, and only a hostile page can trigger it.
    if (!originOk(c.req.raw)) return c.text("forbidden origin", 403);
    const room = rooms.get(c.req.param("id"));
    if (room === undefined) return fail(404, "room_not_found", "unknown room");
    if (!shareLimiter.take(ipOf(c.req.raw))) return fail(429, "rate_limited", "too many shares, slow down");
    if (Number(c.req.header("content-length") ?? 0) > MAX_SHARE_BODY_BYTES) {
      return fail(413, "payload_too_large", "body too large");
    }
    const text = await readBodyCapped(c.req.raw, MAX_SHARE_BODY_BYTES);
    if (text === null) return fail(413, "payload_too_large", "body too large");

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail(400, "invalid_body", "body is not JSON");
    }
    const parsed = v.safeParse(ShareRequestSchema, json);
    if (!parsed.success) return fail(400, "invalid_body", "expected { url: string }");
    const embed = canonicalizeEmbed(parsed.output.url);
    if (embed === null) return fail(400, "unsupported_url", "not a supported video URL");

    room.setEmbed(embed);
    server.publish(room.topic, encode({ type: "embed-changed", embed, by: null }));
    const body: ShareResponse = { ok: true, embed };
    return c.json(body);
  });

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
    ws.data.room.leave(memberId);
    if (!closing) ws.unsubscribe(ws.data.room.topic);
    server.publish(ws.data.room.topic, encode({ type: "member-left", memberId }));
  };

  const handle = (ws: Conn, msg: ClientMessage): void => {
    const { room, memberId } = ws.data;
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
      ws.send(encode({ type: "snapshot", self: member.id, room: room.snapshot() }));
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
        server.publish(room.topic, encode({ type: "seat-changed", memberId, seat: msg.seat }));
        return;
      case "chat":
        server.publish(room.topic, encode({ type: "chat", memberId, text: msg.text, at: Date.now() }));
        return;
      case "ping":
      case "control":
        // Contract only (OME-83); the M1b server issue implements these. Same reply as before they parsed.
        sendError(ws, "bad_message", "invalid message");
        return;
    }
  };

  const server: Server<ConnData> = Bun.serve<ConnData>({
    port: opts.port,
    ...(opts.hostname === undefined ? {} : { hostname: opts.hostname }),
    maxRequestBodySize: 64 * 1024,
    fetch(req, srv) {
      // Cheap test first so ordinary HTTP requests skip URL parsing.
      if (!req.url.includes("/ws")) return app.fetch(req);
      const match = WS_PATH.exec(new URL(req.url).pathname);
      if (match === null) return app.fetch(req);
      const room = rooms.get(match[1] ?? "");
      if (room === undefined) return new Response("unknown room", { status: 404 });
      if (!originOk(req)) return new Response("forbidden origin", { status: 403 });
      const ip = ipOf(req);
      const open = connectionsPerIp.get(ip) ?? 0;
      if (open >= maxConnectionsPerIp) return new Response("too many connections", { status: 429 });
      const data: ConnData = { room, ip, memberId: null, bucket: new TokenBucket(WS_BURST, WS_PER_SECOND), limited: false, joinTimer: null };
      if (!srv.upgrade(req, { data })) return new Response("expected a WebSocket upgrade", { status: 426 });
      connectionsPerIp.set(ip, open + 1);
      return undefined;
    },
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
        const left = (connectionsPerIp.get(ws.data.ip) ?? 1) - 1;
        if (left === 0) connectionsPerIp.delete(ws.data.ip);
        else connectionsPerIp.set(ws.data.ip, left);
        if (ws.data.memberId !== null) depart(ws, ws.data.memberId, true);
      },
    },
  });
  return server;
}
