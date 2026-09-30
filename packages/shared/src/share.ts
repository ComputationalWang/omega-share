import * as v from "valibot";
import { ERROR_MESSAGE_MAX_LENGTH } from "./constants";
import { EmbedSchema, MAX_URL_LENGTH } from "./embed";
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
 * Token from an `Authorization: Bearer <token>` header, or null when the header is
 * missing or malformed. Boundary parser for the share endpoint; never throws.
 */
export function parseShareAuthorization(header: string | null | undefined): ShareToken | null {
  // Bounds the regex input; a valid header is exactly "Bearer " + 22 chars.
  if (header?.length !== 7 + SHARE_TOKEN_LENGTH) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

/** `sessionStorage` key the site writes its share record under; the extension reads it. */
export const SHARE_TOKEN_STORAGE_KEY = "omega.share";

/** Value at `SHARE_TOKEN_STORAGE_KEY`, after `JSON.parse`. */
export const ShareTokenRecordSchema = v.strictObject({ roomId: RoomIdSchema, token: ShareTokenSchema });
export type ShareTokenRecord = v.InferOutput<typeof ShareTokenRecordSchema>;

/**
 * Body of `POST /rooms/:id/share`. The raw page/embed URL; the server runs
 * `canonicalizeEmbed` on it, so the extension never has to be trusted.
 */
export const ShareRequestSchema = v.strictObject({
  url: v.pipe(v.string(), v.maxLength(MAX_URL_LENGTH)),
});
export type ShareRequest = v.InferOutput<typeof ShareRequestSchema>;

export const SHARE_ERROR_CODES = [
  "invalid_body",
  "unsupported_url",
  "room_not_found",
  "rate_limited",
  "payload_too_large",
  /** Missing, malformed or revoked share token, or a token for another room. HTTP 401. */
  "unauthorized",
] as const;
export type ShareErrorCode = (typeof SHARE_ERROR_CODES)[number];

export const ShareResponseSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), embed: EmbedSchema }),
  v.object({
    ok: v.literal(false),
    error: v.object({
      code: v.picklist(SHARE_ERROR_CODES),
      message: v.pipe(v.string(), v.maxLength(ERROR_MESSAGE_MAX_LENGTH)),
    }),
  }),
]);
export type ShareResponse = v.InferOutput<typeof ShareResponseSchema>;
