import * as v from "valibot";
import { ERROR_MESSAGE_MAX_LENGTH, MAX_URL_LENGTH, RETRY_AFTER_MAX_MS } from "./constants";
import { AnyEmbedSchema } from "./generic-embed";
import { QueueItemSchema } from "./queue";
import { RoomIdSchema } from "./room";

/** Length of a share token: 16 random bytes as base64url without padding (ADR 0015). */
export const SHARE_TOKEN_LENGTH = 22;

/**
 * Member-bound secret for `POST /rooms/:id/share`. The server mints it at `join`, sends it
 * only in that member's own `snapshot`, and revokes it on leave or close.
 */
export const ShareTokenSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/));
export type ShareToken = v.InferOutput<typeof ShareTokenSchema>;

const BEARER = /^bearer ([A-Za-z0-9_-]{22})$/i;

/**
 * The 22-char token from an `Authorization: Bearer <token>` header, or null when the header is
 * missing or malformed. Boundary parser for share and owner tokens (ADR 0015, 0028); never throws.
 * It checks the shape only: the caller checks the token against the room.
 */
export function parseBearer(header: string | null | undefined): string | null {
  // Bounds the regex input; a valid header is exactly "Bearer " + 22 chars.
  if (header?.length !== 7 + SHARE_TOKEN_LENGTH) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

/** `parseBearer` for the share endpoint. */
export const parseShareAuthorization: (header: string | null | undefined) => ShareToken | null = parseBearer;

/** `sessionStorage` key the site writes its share record under; the extension reads it. */
export const SHARE_TOKEN_STORAGE_KEY = "omega.share";

/** Value at `SHARE_TOKEN_STORAGE_KEY`, after `JSON.parse`. */
export const ShareTokenRecordSchema = v.strictObject({ roomId: RoomIdSchema, token: ShareTokenSchema });
export type ShareTokenRecord = v.InferOutput<typeof ShareTokenRecordSchema>;

/**
 * Body of `POST /rooms/:id/share`. The raw page/embed URL; the server runs
 * `canonicalizeAnyEmbed` on it, so the extension never has to be trusted.
 */
export const ShareRequestSchema = v.strictObject({
  url: v.pipe(v.string(), v.maxLength(MAX_URL_LENGTH)),
});
export type ShareRequest = v.InferOutput<typeof ShareRequestSchema>;

/**
 * How long to wait before trying again, in ms. Sent with `rate_limited` (WS `error` and
 * share responses); absent from M2 servers.
 */
export const RetryAfterMsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(RETRY_AFTER_MAX_MS));

export const SHARE_ERROR_CODES = [
  "invalid_body",
  "unsupported_url",
  "room_not_found",
  "rate_limited",
  "payload_too_large",
  /** Missing, malformed or revoked share token, or a token for another room. HTTP 401. */
  "unauthorized",
  /** The room's control policy is `owner` and the token's member isn't the owner (ADR 0030). HTTP 403. */
  "control_owner_only",
  /** `POST /rooms/:id/queue` only: the room already has QUEUE_MAX upcoming items (ADR 0031). HTTP 409. */
  "queue_full",
] as const;
export type ShareErrorCode = (typeof SHARE_ERROR_CODES)[number];

export const ShareResponseSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), embed: AnyEmbedSchema }),
  v.object({
    ok: v.literal(false),
    error: v.object({
      code: v.picklist(SHARE_ERROR_CODES),
      message: v.pipe(v.string(), v.maxLength(ERROR_MESSAGE_MAX_LENGTH)),
      /** With `rate_limited`; the server also sends `Retry-After` in seconds. */
      retryAfterMs: v.optional(RetryAfterMsSchema),
    }),
  }),
]);
export type ShareResponse = v.InferOutput<typeof ShareResponseSchema>;

/**
 * Response of `POST /rooms/:id/queue` (ADR 0031): the extension's "Add to queue". Same body, bearer share token,
 * parser and errors as a share, plus `queue_full`; it takes from the same buckets as the WebSocket `queue-add`.
 * On success the room also gets `queue-changed`.
 */
export const QueueAddResponseSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), item: QueueItemSchema }),
  v.object({
    ok: v.literal(false),
    error: v.object({
      code: v.picklist(SHARE_ERROR_CODES),
      message: v.pipe(v.string(), v.maxLength(ERROR_MESSAGE_MAX_LENGTH)),
      retryAfterMs: v.optional(RetryAfterMsSchema),
    }),
  }),
]);
export type QueueAddResponse = v.InferOutput<typeof QueueAddResponseSchema>;
