import { Hono } from "hono";
import { cors } from "hono/cors";
import * as v from "valibot";
import {
  CreateRoomRequestSchema,
  DEFAULT_LAYOUT,
  MAX_CREATE_BODY_BYTES,
  MAX_LISTED_ROOMS,
  MAX_ROOMS,
  RETRY_AFTER_MAX_MS,
  ROOM_CREATE_GLOBAL_BURST,
  ROOM_CREATE_GLOBAL_REFILL_MS,
  ROOM_CREATE_KEY_BURST,
  ROOM_CREATE_KEY_REFILL_MS,
  ROOM_CREATE_RETRY_AFTER_MAX_MS,
  ShareRequestSchema,
  parseBearer,
  parseShareAuthorization,
  type AnyEmbed,
  type CreateRoomErrorCode,
  type CreateRoomResponse,
  type DeleteRoomErrorCode,
  type DeleteRoomResponse,
  type MemberId,
  type RoomListResponse,
  type RoomSummary,
  type ServerMessage,
  type ShareErrorCode,
  type ShareResponse,
  type ShareToken,
} from "@omega/shared";
import type { EmbedPolicy } from "./embed-policy";
import type { SecurityHeaders } from "./headers";
import { KeyedLimiter, TokenBucket, isLoopbackKey, readBodyCapped, type Clock } from "./rate-limit";
import { Room } from "./room";
import type { RoomRegistry } from "./rooms";
import { hashSecret, mintSecret, newRoomId } from "./secrets";
import { mountSite } from "./static";
import type { NewRoom } from "./store/rooms";

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
/** Per client: failed `DELETE /rooms/:id` attempts (bad or missing owner token), as for shares. */
const FAILED_DELETE_BURST = 20;
const FAILED_DELETE_PER_SECOND = 1;
/** Site routes (`/r/<id>`): a private room's link posted somewhere public must not be indexed (ADR 0028 §4). */
const ROBOTS = "noindex, nofollow";
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
  /** Writes a created room to the store (ADR 0028); throws if it can't. */
  persistRoom: (room: NewRoom) => void;
  /** Deletes an owner-deleted room's row (ADR 0028 §2); throws if it can't. */
  unpersistRoom: (room: Room) => void;
  /** Whether a (normalised) room title contains a ROOM_TITLE_BLOCKLIST term. */
  titleBlocked: (title: string) => boolean;
}

/**
 * Pinned rooms first, in seed order (the lobby leads), so a flood of new rooms can't push them out;
 * then created rooms, the busiest first, then the newest (research §3.5).
 */
interface Listed {
  room: Room;
  summary: RoomSummary;
}
function listOrder({ room: a, summary: sa }: Listed, { room: b, summary: sb }: Listed): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned) return a.createdAt - b.createdAt;
  return sb.memberCount - sa.memberCount || b.createdAt - a.createdAt;
}

export function createHttpApp({
  rooms,
  shareGrant,
  now,
  isAllowedOrigin,
  ipOf,
  publish,
  persistEmbed,
  embeds,
  headers,
  staticDir,
  persistRoom,
  unpersistRoom,
  titleBlocked,
}: HttpDeps): Hono {
  const creates = new KeyedLimiter(ROOM_CREATE_KEY_BURST, 1000 / ROOM_CREATE_KEY_REFILL_MS, 1024, now);
  const globalCreates = new TokenBucket(ROOM_CREATE_GLOBAL_BURST, 1000 / ROOM_CREATE_GLOBAL_REFILL_MS, now);
  const failedDeletes = new KeyedLimiter(FAILED_DELETE_BURST, FAILED_DELETE_PER_SECOND, 1024, now);
  const shareLimiter = new KeyedLimiter(SHARE_BURST, SHARE_PER_SECOND, 1024, now);
  const globalShares = new TokenBucket(GLOBAL_SHARE_BURST, GLOBAL_SHARE_PER_SECOND, now);
  const failedShares = new KeyedLimiter(FAILED_SHARE_BURST, FAILED_SHARE_PER_SECOND, 1024, now);
  // Dropped with the room (RoomRegistry.removeRoom).
  const roomShares = rooms.perRoom(() => new TokenBucket(ROOM_SHARE_BURST, ROOM_SHARE_PER_SECOND, now));
  // Folding a title is about 10 µs, so the verdict is kept per room rather than redone for every list
  // request (OME-439). A title change (title-set) must `drop` the room's entry.
  const listable = rooms.perRoom((room) => room.visibility === "public" && !titleBlocked(room.title));

  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    for (const [k, value] of Object.entries(headers)) c.res.headers.set(k, value);
    if (c.req.path.startsWith("/r/")) c.res.headers.set("x-robots-tag", ROBOTS);
  });
  const apiCors = cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
    allowMethods: ["GET", "POST", "DELETE"],
    allowHeaders: ["content-type", "authorization", "ngrok-skip-browser-warning"],
    maxAge: 600,
  });
  app.use("/rooms", apiCors);
  app.use("/rooms/*", apiCors);

  /** Readiness probe (supervisors). Without a static site, `GET /` answers too (Playwright webServer). */
  app.get("/healthz", (c) => c.text("ok"));
  if (staticDir === null) app.get("/", (c) => c.text("omega-share server"));

  app.get("/rooms", (c) => {
    // At most MAX_ROOMS (500) rooms: filtering and sorting them per request is microseconds (research P2).
    const listed: Listed[] = [];
    for (const room of rooms.values()) if (listable.get(room)) listed.push({ room, summary: room.summary() });
    listed.sort(listOrder);
    const body: RoomListResponse = { rooms: listed.slice(0, MAX_LISTED_ROOMS).map((l) => l.summary) };
    return c.json(body);
  });

  app.post("/rooms", async (c) => {
    c.header("cache-control", "no-store");
    const fail = (status: 400 | 413 | 503, code: CreateRoomErrorCode, message: string) => {
      const body: CreateRoomResponse = { ok: false, error: { code, message } };
      return c.json(body, status);
    };
    const limited = (retryAfterMs: number) => {
      // Not RETRY_AFTER_MAX_MS: the per-key bucket refills in 10 min, and a shorter answer only earns more refusals.
      const ms = Math.max(1000, Math.min(ROOM_CREATE_RETRY_AFTER_MAX_MS, retryAfterMs));
      c.header("retry-after", String(Math.ceil(ms / 1000)));
      const body: CreateRoomResponse = { ok: false, error: { code: "rate_limited", message: "too many new rooms, try again later", retryAfterMs: ms } };
      return c.json(body, 429);
    };
    const ip = ipOf(c.req.raw);
    // Before reading the body: malformed spam costs a creation too (ADR 0028 §1).
    if (!creates.take(ip)) return limited(creates.retryAfterMs(ip, ROOM_CREATE_RETRY_AFTER_MAX_MS));
    if (Number(c.req.header("content-length") ?? 0) > MAX_CREATE_BODY_BYTES) return fail(413, "payload_too_large", "body too large");
    const text = await readBodyCapped(c.req.raw, MAX_CREATE_BODY_BYTES);
    if (text === null) return fail(413, "payload_too_large", "body too large");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail(400, "invalid_body", "body is not JSON");
    }
    const parsed = v.safeParse(CreateRoomRequestSchema, json);
    if (!parsed.success) return fail(400, "invalid_body", "expected { title, visibility }");
    const { title, visibility } = parsed.output;
    if (titleBlocked(title)) return fail(400, "invalid_body", "that title isn't allowed");
    // Refuse, never evict: evicting would let anyone delete other people's rooms by creating new ones.
    if (rooms.size >= MAX_ROOMS) return fail(503, "too_many_rooms", "too many rooms right now, try again later");
    if (!globalCreates.take()) return limited(globalCreates.retryAfterMs());

    let id = newRoomId();
    // 128 random bits: a clash with a live room is never expected, but never reuse an id.
    while (rooms.get(id) !== undefined) id = newRoomId();
    const ownerToken = mintSecret();
    const inviteKey = visibility === "private" ? mintSecret() : null;
    const room: NewRoom = {
      id,
      title,
      createdAt: Date.now(),
      layout: DEFAULT_LAYOUT,
      visibility,
      pinned: false,
      ownerHash: hashSecret(ownerToken),
      inviteHash: inviteKey === null ? null : hashSecret(inviteKey),
    };
    // Store first: if the write fails the creation fails, and memory never runs ahead of the DB.
    try {
      persistRoom(room);
    } catch (err) {
      console.error(`could not store new room ${id}: ${err instanceof Error ? err.message : String(err)}`);
      // The server's failure, not the client's: it keeps its creations.
      creates.refund(ip);
      globalCreates.refund();
      return fail(503, "unavailable", "can't create rooms right now, try again later");
    }
    rooms.addRoom(new Room(id, room));
    const body: CreateRoomResponse =
      inviteKey === null
        ? { ok: true, room: { id, title, visibility }, ownerToken }
        : { ok: true, room: { id, title, visibility }, ownerToken, inviteKey };
    return c.json(body, 201);
  });

  app.delete("/rooms/:id", (c) => {
    const fail = (status: 401 | 404 | 503, code: DeleteRoomErrorCode, message: string) => {
      const body: DeleteRoomResponse = { ok: false, error: { code, message } };
      return c.json(body, status);
    };
    const room = rooms.get(c.req.param("id"));
    if (room === undefined) return fail(404, "room_not_found", "unknown room");
    const token = parseBearer(c.req.header("authorization"));
    if (token === null || !room.isOwner(token)) {
      const ip = ipOf(c.req.raw);
      if (!failedDeletes.take(ip)) {
        const retryAfterMs = Math.max(1000, failedDeletes.retryAfterMs(ip));
        c.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
        const body: DeleteRoomResponse = { ok: false, error: { code: "rate_limited", message: "too many attempts, slow down", retryAfterMs } };
        return c.json(body, 429);
      }
      return fail(401, "unauthorized", "only the room's owner can delete it");
    }
    // The row first: "deleted" must mean the owner hash is gone from disk, not that it comes back at the next boot.
    try {
      unpersistRoom(room);
    } catch (err) {
      console.error(`could not delete room ${room.id} from the store: ${err instanceof Error ? err.message : String(err)}`);
      return fail(503, "unavailable", "couldn't delete the room right now, try again later");
    }
    // Then the one path with GC and the operator: sockets close with ROOM_CLOSED, revoking their share grants.
    rooms.removeRoom(room);
    const body: DeleteRoomResponse = { ok: true };
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
