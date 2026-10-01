import { Hono } from "hono";
import { cors } from "hono/cors";
import * as v from "valibot";
import {
  MAX_LISTED_ROOMS,
  RETRY_AFTER_MAX_MS,
  ShareRequestSchema,
  canonicalizeEmbed,
  parseShareAuthorization,
  type Embed,
  type MemberId,
  type RoomListResponse,
  type ServerMessage,
  type ShareErrorCode,
  type ShareResponse,
  type ShareToken,
} from "@omega/shared";
import { SECURITY_HEADERS } from "./headers";
import { KeyedLimiter, TokenBucket, readBodyCapped } from "./rate-limit";
import type { Room } from "./room";
import { mountSite } from "./static";

/** Share bodies are `{ url }` with url ≤ 2048 chars; anything bigger is refused unread. */
const MAX_SHARE_BODY_BYTES = 4096;
/** Per client and per member: 5 shares at once, then one every 3 s. */
const SHARE_BURST = 5;
const SHARE_PER_SECOND = 1 / 3;
/** Per client: unauthorized share attempts (bad or missing token). */
const FAILED_SHARE_BURST = 20;
const FAILED_SHARE_PER_SECOND = 1;
/** All shares together, whatever the key (ADR 0015 §6): bounds many-address floods. */
const GLOBAL_SHARE_BURST = 20;
const GLOBAL_SHARE_PER_SECOND = 2;
/** Per room: 2 switches at once, then one every 10 s (threat model §6; any member may share until B1). */
const ROOM_SHARE_BURST = 2;
const ROOM_SHARE_PER_SECOND = 0.1;
export const plain = (status: number, text: string): Response => new Response(text, { status, headers: SECURITY_HEADERS });

const encode = (msg: ServerMessage): string => JSON.stringify(msg);

/** What a joined member's share token authorizes. Minted on join (ws.ts), revoked on leave. */
export interface ShareGrant {
  room: Room;
  memberId: MemberId;
  bucket: TokenBucket;
}
export const newShareGrant = (room: Room, memberId: MemberId): ShareGrant => ({
  room,
  memberId,
  bucket: new TokenBucket(SHARE_BURST, SHARE_PER_SECOND),
});

export interface HttpDeps {
  rooms: ReadonlyMap<string, Room>;
  shareGrants: ReadonlyMap<ShareToken, ShareGrant>;
  isAllowedOrigin: (origin: string) => boolean;
  ipOf: (req: Request) => string;
  publish: (topic: string, data: string) => void;
  /** Writes the room's new embed through to the store (OME-280); throws if it can't. */
  persistEmbed: (room: Room, embed: Embed) => void;
  staticDir: string | null;
}

export function createHttpApp({ rooms, shareGrants, isAllowedOrigin, ipOf, publish, persistEmbed, staticDir }: HttpDeps): Hono {
  const shareLimiter = new KeyedLimiter(SHARE_BURST, SHARE_PER_SECOND);
  const globalShares = new TokenBucket(GLOBAL_SHARE_BURST, GLOBAL_SHARE_PER_SECOND);
  const failedShares = new KeyedLimiter(FAILED_SHARE_BURST, FAILED_SHARE_PER_SECOND);
  // Rooms are fixed at startup, so this holds at most one bucket per room.
  const roomShares = new Map<Room, TokenBucket>();
  const roomBucket = (room: Room): TokenBucket => {
    let bucket = roomShares.get(room);
    if (bucket === undefined) {
      bucket = new TokenBucket(ROOM_SHARE_BURST, ROOM_SHARE_PER_SECOND);
      roomShares.set(room, bucket);
    }
    return bucket;
  };

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
  if (staticDir === null) app.get("/", (c) => c.text("omega-share server"));

  app.get("/rooms", (c) => {
    const listed = [...rooms.values()].slice(0, MAX_LISTED_ROOMS);
    const body: RoomListResponse = { rooms: listed.map((r) => r.summary()) };
    return c.json(body);
  });

  app.post("/rooms/:id/share", async (c) => {
    const fail = (status: 400 | 401 | 404 | 413, code: ShareErrorCode, message: string) => {
      const body: ShareResponse = { ok: false, error: { code, message } };
      return c.json(body, status);
    };
    /**
     * 429 for a bucket refilling at `perSecond`. The wait is its refill period, an upper bound on the
     * time to the next token (TokenBucket doesn't expose its level). Retry-After is whole seconds.
     */
    const limited = (perSecond: number) => {
      const retryAfterMs = Math.min(RETRY_AFTER_MAX_MS, Math.ceil(1000 / perSecond));
      c.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
      const body: ShareResponse = { ok: false, error: { code: "rate_limited", message: "too many shares, slow down", retryAfterMs } };
      return c.json(body, 429);
    };
    const room = rooms.get(c.req.param("id"));
    if (room === undefined) return fail(404, "room_not_found", "unknown room");
    const ip = ipOf(c.req.raw);
    const token = parseShareAuthorization(c.req.header("authorization"));
    const grant = token === null ? undefined : shareGrants.get(token);
    // Failures have their own bucket, so guessing is bounded without locking out members on the same address.
    if (grant?.room !== room) {
      if (!failedShares.take(ip)) return limited(FAILED_SHARE_PER_SECOND);
      return fail(401, "unauthorized", "join the room to share into it");
    }
    if (!shareLimiter.take(ip) || !grant.bucket.take()) return limited(SHARE_PER_SECOND);
    if (!globalShares.take()) return limited(GLOBAL_SHARE_PER_SECOND);
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
    // Last, so a refused request never uses up the room's switches.
    if (!roomBucket(room).take()) return limited(ROOM_SHARE_PER_SECOND);

    // Store first: if the write fails the share fails, and memory never runs ahead of the DB.
    persistEmbed(room, embed);
    const playback = room.setEmbed(embed, grant.memberId);
    publish(room.topic, encode({ type: "embed-changed", embed, by: grant.memberId, playback }));
    const body: ShareResponse = { ok: true, embed };
    return c.json(body);
  });

  if (staticDir !== null) mountSite(app, staticDir);
  return app;
}
