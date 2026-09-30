import { Hono } from "hono";
import { cors } from "hono/cors";
import * as v from "valibot";
import {
  MAX_LISTED_ROOMS,
  ShareRequestSchema,
  canonicalizeEmbed,
  parseShareAuthorization,
  type MemberId,
  type RoomListResponse,
  type ServerMessage,
  type ShareErrorCode,
  type ShareResponse,
  type ShareToken,
} from "@omega/shared";
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
/**
 * On every response. The header CSP carries only `frame-ancestors` (a `<meta>` CSP can't); header and
 * meta CSPs intersect, so the `<meta>` in index.html stays the single source for the rest.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "frame-ancestors 'none'",
};
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
  staticDir: string | null;
}

export function createHttpApp({ rooms, shareGrants, isAllowedOrigin, ipOf, publish, staticDir }: HttpDeps): Hono {
  const shareLimiter = new KeyedLimiter(SHARE_BURST, SHARE_PER_SECOND);
  const globalShares = new TokenBucket(GLOBAL_SHARE_BURST, GLOBAL_SHARE_PER_SECOND);
  const failedShares = new KeyedLimiter(FAILED_SHARE_BURST, FAILED_SHARE_PER_SECOND);

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
    publish(room.topic, encode({ type: "embed-changed", embed, by: grant.memberId, playback }));
    const body: ShareResponse = { ok: true, embed };
    return c.json(body);
  });

  if (staticDir !== null) mountSite(app, staticDir);
  return app;
}
