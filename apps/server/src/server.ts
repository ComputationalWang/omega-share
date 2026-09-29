import type { Server, ServerWebSocket } from "bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as v from "valibot";
import {
  DEFAULT_ROOM_ID,
  MAX_CLIENT_MESSAGE_BYTES,
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
import { Room } from "./room";

export interface ServerOptions {
  port: number;
  hostname?: string;
  /** The site's origin, e.g. `http://localhost:5173`. Only it and extension origins may call the API. */
  siteOrigin: string;
}

interface ConnData {
  room: Room;
  memberId: MemberId | null;
}
type Conn = ServerWebSocket<ConnData>;

/** Share bodies are `{ url }` with url ≤ 2048 chars; anything bigger is refused unread. */
const MAX_SHARE_BODY_BYTES = 4096;
const WS_PATH = /^\/rooms\/([^/]+)\/ws$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

const encode = (msg: ServerMessage): string => JSON.stringify(msg);

export function startServer(opts: ServerOptions): Server<ConnData> {
  const rooms = new Map<string, Room>([[DEFAULT_ROOM_ID, new Room(DEFAULT_ROOM_ID)]]);
  const isAllowedOrigin = (origin: string): boolean => origin === opts.siteOrigin || EXTENSION_ORIGIN.test(origin);
  /** Browsers always send Origin; non-browser clients may omit it and are not a CSRF vector. */
  const originOk = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    return origin === null || isAllowedOrigin(origin);
  };

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
  app.use("/rooms", cors({ origin: (origin) => (isAllowedOrigin(origin) ? origin : null), allowMethods: ["GET"] }));

  app.get("/rooms", (c) => {
    const body: RoomListResponse = { rooms: [...rooms.values()].map((r) => r.summary()) };
    return c.json(body);
  });

  app.post("/rooms/:id/share", async (c) => {
    const fail = (status: 400 | 404 | 413, code: ShareErrorCode, message: string) => {
      const body: ShareResponse = { ok: false, error: { code, message } };
      return c.json(body, status);
    };
    if (!originOk(c.req.raw)) return c.text("forbidden origin", 403);
    const room = rooms.get(c.req.param("id"));
    if (room === undefined) return fail(404, "room_not_found", "unknown room");
    if (Number(c.req.header("content-length") ?? 0) > MAX_SHARE_BODY_BYTES) {
      return fail(413, "payload_too_large", "body too large");
    }
    const text = await c.req.text();
    if (text.length > MAX_SHARE_BODY_BYTES) return fail(413, "payload_too_large", "body too large");

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

  const depart = (ws: Conn, memberId: MemberId): void => {
    ws.data.memberId = null;
    ws.data.room.leave(memberId);
    ws.unsubscribe(ws.data.room.topic);
    server.publish(ws.data.room.topic, encode({ type: "member-left", memberId }));
  };

  const handle = (ws: Conn, msg: ClientMessage): void => {
    const { room, memberId } = ws.data;
    if (msg.type === "join") {
      if (memberId !== null) { sendError(ws, "already_joined", "already joined"); return; }
      const member = room.join(msg.nickname, msg.avatar);
      if (member === null) {
        ws.send(encode({ type: "room-full" }));
        ws.close(1008, "room full");
        return;
      }
      ws.data.memberId = member.id;
      ws.send(encode({ type: "snapshot", self: member.id, room: room.snapshot() }));
      ws.subscribe(room.topic);
      ws.publish(room.topic, encode({ type: "member-joined", member }));
      return;
    }
    if (memberId === null) { sendError(ws, "not_joined", "join first"); return; }
    switch (msg.type) {
      case "leave":
        depart(ws, memberId);
        return;
      case "sit":
        if (room.sit(memberId, msg.seat) === "seat_taken") { sendError(ws, "seat_taken", "seat is taken"); return; }
        server.publish(room.topic, encode({ type: "seat-changed", memberId, seat: msg.seat }));
        return;
      case "chat":
        server.publish(room.topic, encode({ type: "chat", memberId, text: msg.text, at: Date.now() }));
        return;
    }
  };

  const server: Server<ConnData> = Bun.serve<ConnData>({
    port: opts.port,
    ...(opts.hostname === undefined ? {} : { hostname: opts.hostname }),
    maxRequestBodySize: 64 * 1024,
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      const match = WS_PATH.exec(path);
      if (match !== null) {
        const room = rooms.get(match[1] ?? "");
        if (room === undefined) return new Response("unknown room", { status: 404 });
        if (!originOk(req)) return new Response("forbidden origin", { status: 403 });
        if (srv.upgrade(req, { data: { room, memberId: null } })) return undefined;
        return new Response("expected a WebSocket upgrade", { status: 426 });
      }
      return app.fetch(req);
    },
    websocket: {
      maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
      message(ws, raw) {
        const msg = typeof raw === "string" ? parseClientMessage(raw) : null;
        if (msg === null) { sendError(ws, "bad_message", "invalid message"); return; }
        handle(ws, msg);
      },
      close(ws) {
        if (ws.data.memberId !== null) depart(ws, ws.data.memberId);
      },
    },
  });
  return server;
}
