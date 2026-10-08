import { Hono } from "hono";
import { cors } from "hono/cors";
import * as v from "valibot";
import {
  MAX_LISTED_ROOMS,
  RETRY_AFTER_MAX_MS,
  ShareRequestSchema,
  parseShareAuthorization,
  type AnyEmbed,
  type MemberId,
  type RoomListResponse,
  type ServerMessage,
  type ShareErrorCode,
  type ShareResponse,
  type ShareToken,
} from "@omega/shared";
import type { EmbedPolicy } from "./embed-policy";
import type { SecurityHeaders } from "./headers";
import { KeyedLimiter, TokenBucket, isLoopbackKey, readBodyCapped, type Clock } from "./rate-limit";
import type { Room } from "./room";
import type { RoomRegistry } from "./rooms";
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
/**
 * Per client key, every HTTP route (threat model §10). A cold page load is about 30 requests (index, JS
 * chunks, CSS, atlas, source maps with devtools open, `/rooms`), so a burst of 120 covers a load and a few
 * reloads; 20/s sustained is more than any person browsing needs.
 */
const HTTP_BURST = 120;
const HTTP_PER_SECOND = 20;
/** HTTP requests being handled at once, whatever their keys. Default for `ServerOptions.maxHttpInFlight`. */
export const MAX_HTTP_IN_FLIGHT = 256;
export const plain = (status: number, text: string, headers: SecurityHeaders): Response => new Response(text, { status, headers });
const withRetryAfter = (res: Response, ms: number): Response => {
  res.headers.set("retry-after", String(Math.max(1, Math.ceil(ms / 1000))));
  return res;
};

/**
 * Wraps the HTTP app (not WebSocket upgrades, which have their own limiter, ADR 0018) in a per-key request
 * bucket (429) and a global in-flight cap (503). Loopback keys skip the per-key bucket, as in ADR 0018 §3.
 */
export function createHttpGate(
  handle: (req: Request) => Response | Promise<Response>,
  { now, maxInFlight, headers }: { now: Clock; maxInFlight: number; headers: SecurityHeaders },
): (req: Request, key: string) => Promise<Response> {
  const requests = new KeyedLimiter(HTTP_BURST, HTTP_PER_SECOND, 1024, now);
  let inFlight = 0;
  return async (req, key) => {
    if (!isLoopbackKey(key) && !requests.take(key)) return withRetryAfter(plain(429, "too many requests", headers), requests.retryAfterMs(key));
    if (inFlight >= maxInFlight) return withRetryAfter(plain(503, "server busy", headers), 1000);
    inFlight++;
    try {
      return await handle(req);
    } finally {
      inFlight--;
    }
  };
}

const encode = (msg: ServerMessage): string => JSON.stringify(msg);

/** What a joined member's share token authorizes in its room. Minted on join (ws.ts), revoked on leave. */
export interface ShareGrant {
  memberId: MemberId;
  bucket: TokenBucket;
}
export const newShareGrant = (memberId: MemberId): ShareGrant => ({
  memberId,
  bucket: new TokenBucket(SHARE_BURST, SHARE_PER_SECOND),
});

export interface HttpDeps {
  rooms: RoomRegistry;
  /** The grant `token` holds in `room` (ws.ts), if any. */
  shareGrant: (room: Room, token: ShareToken) => ShareGrant | undefined;
  /** Clock for the share limiters. */
  now: Clock;
  isAllowedOrigin: (origin: string) => boolean;
  ipOf: (req: Request) => string;
  publish: (topic: string, data: string) => void;
  /** Writes the room's new embed through to the store (OME-280); throws if it can't. */
  persistEmbed: (room: Room, embed: AnyEmbed) => void;
  /** What a shared URL may become (ADR 0024). */
  embeds: EmbedPolicy;
  /** `securityHeaders(embeds.genericEmbeds)`, set on every response. */
  headers: SecurityHeaders;
  staticDir: string | null;
}

export function createHttpApp({ rooms, shareGrant, now, isAllowedOrigin, ipOf, publish, persistEmbed, embeds, headers, staticDir }: HttpDeps): Hono {
  const shareLimiter = new KeyedLimiter(SHARE_BURST, SHARE_PER_SECOND, 1024, now);
  const globalShares = new TokenBucket(GLOBAL_SHARE_BURST, GLOBAL_SHARE_PER_SECOND, now);
  const failedShares = new KeyedLimiter(FAILED_SHARE_BURST, FAILED_SHARE_PER_SECOND, 1024, now);
  // Dropped with the room (RoomRegistry.removeRoom).
  const roomShares = rooms.perRoom(() => new TokenBucket(ROOM_SHARE_BURST, ROOM_SHARE_PER_SECOND, now));

  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    for (const [k, value] of Object.entries(headers)) c.res.headers.set(k, value);
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
    const grant = token === null ? undefined : shareGrant(room, token);
    // Failures have their own bucket, so guessing is bounded without locking out members on the same address.
    if (grant === undefined) {
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
    // The room may have gone while the body arrived: never store or publish into it.
    if (!rooms.has(room)) return fail(404, "room_not_found", "unknown room");

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail(400, "invalid_body", "body is not JSON");
    }
    const parsed = v.safeParse(ShareRequestSchema, json);
    if (!parsed.success) return fail(400, "invalid_body", "expected { url: string }");
    // A denied host gets the same answer as any other refused URL (ADR 0024 §6).
    const embed = embeds.accept(parsed.output.url);
    if (embed === null) return fail(400, "unsupported_url", "not a supported video URL");
    // Last, so a refused request never uses up the room's switches.
    if (!roomShares.get(room).take()) return limited(ROOM_SHARE_PER_SECOND);

    // Store first: if the write fails the share fails, and memory never runs ahead of the DB.
    persistEmbed(room, embed);
    const { playback, uncaught } = room.setEmbed(embed, grant.memberId);
    publish(room.topic, encode({ type: "embed-changed", embed, by: grant.memberId, playback }));
    for (const memberId of uncaught) publish(room.topic, encode({ type: "member-status", memberId, catching: false }));
    const body: ShareResponse = { ok: true, embed };
    return c.json(body);
  });

  if (staticDir !== null) mountSite(app, staticDir);
  return app;
}
