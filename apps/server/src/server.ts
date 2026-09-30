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
  parseShareAuthorization,
  type RoomId,
  type ClientMessage,
  type ErrorCode,
  type MemberId,
  type RoomListResponse,
  type ServerMessage,
  type ShareErrorCode,
  type ShareResponse,
  type ShareToken,
} from "@omega/shared";
import { KeyedLimiter, TokenBucket, clientKey, readBodyCapped } from "./rate-limit";
import { Room } from "./room";
import { mountSite } from "./static";

export interface ServerOptions {
  port: number;
  /** Default `127.0.0.1`: only the tunnel agent (or the operator) reaches the server (ADR 0015 §3). */
  hostname?: string;
  /** The dev site's origin, e.g. `http://localhost:5173`. It, the public origin, our own loopback origins and extension origins may call the API. */
  siteOrigin: string;
  /** The tunnel's `https://` origin; its host joins the Host allowlist and it joins the Origin allowlist. */
  publicOrigin?: string | null;
  /** Serve this built site (`apps/web/dist`, absolute path) on the same origin as the API. */
  staticDir?: string | null;
  /** Allowed extension ids; null or absent allows any Chromium extension id. */
  extensionIds?: readonly string[] | null;
  /** Sockets that have not joined within this are closed. Default 10 s. */
  joinTimeoutMs?: number;
  /** Key limits by the rightmost `X-Forwarded-For` entry when the peer is loopback (the tunnel agent). */
  trustProxy?: boolean;
  /** Open WebSockets allowed per client. Default 10 behind the proxy, 50 locally (the load test). */
  maxConnectionsPerIp?: number;
  /** Open WebSockets allowed in total, whatever their clients. Default 200. */
  maxConnections?: number;
  /** Rooms that exist. Default: just the lobby. */
  rooms?: readonly RoomId[];
}

interface ConnData {
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

/** Share bodies are `{ url }` with url ≤ 2048 chars; anything bigger is refused unread. */
const MAX_SHARE_BODY_BYTES = 4096;
/** Per socket: bursts of 20 messages, 10/s sustained. Human pace; stops relay amplification. */
const WS_BURST = 20;
const WS_PER_SECOND = 10;
/** Per socket, `control` only: 4/s (docs/research/m1b-youtube-sync.md §6). */
const CONTROL_BURST = 4;
const CONTROL_PER_SECOND = 4;
/** Per client and per member: 5 shares at once, then one every 3 s. */
const SHARE_BURST = 5;
const SHARE_PER_SECOND = 1 / 3;
/** Per client: unauthorized share attempts (bad or missing token). */
const FAILED_SHARE_BURST = 20;
const FAILED_SHARE_PER_SECOND = 1;
/** All shares together, whatever the key (ADR 0015 §6): bounds many-address floods. */
const GLOBAL_SHARE_BURST = 20;
const GLOBAL_SHARE_PER_SECOND = 2;
const WS_PATH = /^\/rooms\/([^/]+)\/ws$/;
/**
 * On every response. The header CSP carries only `frame-ancestors` (a `<meta>` CSP can't); header and
 * meta CSPs intersect, so the `<meta>` in index.html stays the single source for the rest.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "frame-ancestors 'none'",
};
const plain = (status: number, text: string): Response => new Response(text, { status, headers: SECURITY_HEADERS });
/** Any Chromium extension id, unless `extensionIds` (EXTENSION_IDS) pins the published ones. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

const encode = (msg: ServerMessage): string => JSON.stringify(msg);
/** 16 random bytes, base64url without padding: 22 chars (ADR 0015). */
const mintShareToken = (): ShareToken => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

interface ShareGrant {
  room: Room;
  memberId: MemberId;
  bucket: TokenBucket;
}

export function startServer(opts: ServerOptions): Server<ConnData> {
  const joinTimeoutMs = opts.joinTimeoutMs ?? 10_000;
  const trustProxy = opts.trustProxy ?? false;
  const maxConnectionsPerIp = opts.maxConnectionsPerIp ?? (trustProxy ? 10 : 50);
  const maxConnections = opts.maxConnections ?? 200;
  let connections = 0;
  const rooms = new Map<string, Room>((opts.rooms ?? [DEFAULT_ROOM_ID]).map((id) => [id, new Room(id)]));
  const connectionsPerIp = new Map<string, number>();
  const shareLimiter = new KeyedLimiter(SHARE_BURST, SHARE_PER_SECOND);
  const globalShares = new TokenBucket(GLOBAL_SHARE_BURST, GLOBAL_SHARE_PER_SECOND);
  const failedShares = new KeyedLimiter(FAILED_SHARE_BURST, FAILED_SHARE_PER_SECOND);
  const shareGrants = new Map<ShareToken, ShareGrant>();

  // Filled in once Bun has picked the port (tests use port 0); no request arrives before that.
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>([opts.siteOrigin]);
  const extensionOrigins = opts.extensionIds?.map((id) => `chrome-extension://${id}`) ?? null;
  const isAllowedOrigin = (origin: string): boolean =>
    allowedOrigins.has(origin) || (extensionOrigins === null ? EXTENSION_ORIGIN.test(origin) : extensionOrigins.includes(origin));
  /** Refuses DNS rebinding: only our public host and loopback names on our port (ADR 0015 §4). */
  const hostOk = (req: Request): boolean => allowedHosts.has(req.headers.get("host")?.toLowerCase() ?? "");
  /** Browsers always send Origin cross-origin; non-browser clients may omit it and are not a CSRF vector. */
  const originOk = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    return origin === null || isAllowedOrigin(origin);
  };
  const ipOf = (req: Request): string =>
    clientKey(server.requestIP(req)?.address ?? "unknown", req.headers.get("x-forwarded-for"), trustProxy);

  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    for (const [k, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, value);
  });
  app.use(
    "/rooms/*",
    cors({
      origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
      allowMethods: ["GET", "POST"],
      allowHeaders: ["content-type", "authorization", "ngrok-skip-browser-warning"],
      maxAge: 600,
    }),
  );

  /** Readiness probe (supervisors). Without a static site, `GET /` answers too (Playwright webServer). */
  app.get("/healthz", (c) => c.text("ok"));
  if (opts.staticDir == null) app.get("/", (c) => c.text("omega-share server"));

  app.get("/rooms", (c) => {
    const listed = [...rooms.values()].slice(0, MAX_LISTED_ROOMS);
    const body: RoomListResponse = { rooms: listed.map((r) => r.summary()) };
    return c.json(body);
  });

  app.post("/rooms/:id/share", async (c) => {
    const fail = (status: 400 | 401 | 404 | 413 | 429, code: ShareErrorCode, message: string) => {
      const body: ShareResponse = { ok: false, error: { code, message } };
      return c.json(body, status);
    };
    const room = rooms.get(c.req.param("id"));
    if (room === undefined) return fail(404, "room_not_found", "unknown room");
    const ip = ipOf(c.req.raw);
    const token = parseShareAuthorization(c.req.header("authorization"));
    const grant = token === null ? undefined : shareGrants.get(token);
    // Failures have their own bucket, so guessing is bounded without locking out members on the same address.
    if (grant?.room !== room) {
      if (!failedShares.take(ip)) return fail(429, "rate_limited", "too many shares, slow down");
      return fail(401, "unauthorized", "join the room to share into it");
    }
    if (!shareLimiter.take(ip) || !grant.bucket.take() || !globalShares.take()) {
      return fail(429, "rate_limited", "too many shares, slow down");
    }
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

    const playback = room.setEmbed(embed, grant.memberId);
    server.publish(room.topic, encode({ type: "embed-changed", embed, by: grant.memberId, playback }));
    const body: ShareResponse = { ok: true, embed };
    return c.json(body);
  });

  if (opts.staticDir != null) mountSite(app, opts.staticDir);

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
    server.publish(ws.data.room.topic, encode({ type: "member-left", memberId }));
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
      shareGrants.set(shareToken, { room, memberId: member.id, bucket: new TokenBucket(SHARE_BURST, SHARE_PER_SECOND) });
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
        server.publish(room.topic, encode({ type: "seat-changed", memberId, seat: msg.seat }));
        return;
      case "chat":
        server.publish(room.topic, encode({ type: "chat", memberId, text: msg.text, at: Date.now() }));
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
        server.publish(room.topic, encode({ type: "playback", playback }));
        return;
      }
    }
  };

  const server: Server<ConnData> = Bun.serve<ConnData>({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    maxRequestBodySize: 64 * 1024,
    fetch(req, srv) {
      // Before routing, for HTTP and upgrades alike (ADR 0015 §4).
      if (!hostOk(req)) return plain(421, "misdirected request");
      // Not a ShareResponse: the contract has no code for it, and only a hostile page can trigger it.
      if (!originOk(req)) return plain(403, "forbidden origin");
      // Cheap test first so ordinary HTTP requests skip URL parsing.
      if (!req.url.includes("/ws")) return app.fetch(req);
      const match = WS_PATH.exec(new URL(req.url).pathname);
      if (match === null) return app.fetch(req);
      const room = rooms.get(match[1] ?? "");
      if (room === undefined) return plain(404, "unknown room");
      if (connections >= maxConnections) return plain(503, "server full");
      const ip = ipOf(req);
      const open = connectionsPerIp.get(ip) ?? 0;
      if (open >= maxConnectionsPerIp) return plain(429, "too many connections");
      const data: ConnData = {
        room,
        ip,
        memberId: null,
        shareToken: null,
        bucket: new TokenBucket(WS_BURST, WS_PER_SECOND),
        limited: false,
        controlBucket: new TokenBucket(CONTROL_BURST, CONTROL_PER_SECOND),
        controlLimited: false,
        joinTimer: null,
      };
      if (!srv.upgrade(req, { data })) return plain(426, "expected a WebSocket upgrade");
      connectionsPerIp.set(ip, open + 1);
      connections++;
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
        connections--;
        const left = (connectionsPerIp.get(ws.data.ip) ?? 1) - 1;
        if (left === 0) connectionsPerIp.delete(ws.data.ip);
        else connectionsPerIp.set(ws.data.ip, left);
        if (ws.data.memberId !== null) depart(ws, ws.data.memberId, true);
      },
    },
  });
  const port = String(server.port);
  for (const name of ["localhost", "127.0.0.1", "[::1]"]) {
    allowedHosts.add(`${name}:${port}`);
    // A page served from here (STATIC_DIR, or anything else on our port) is us.
    allowedOrigins.add(`http://${name}:${port}`);
  }
  if (opts.publicOrigin != null) {
    allowedHosts.add(new URL(opts.publicOrigin).host);
    allowedOrigins.add(opts.publicOrigin);
  }
  return server;
}
