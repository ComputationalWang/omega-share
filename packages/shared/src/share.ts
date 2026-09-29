import * as v from "valibot";
import { ERROR_MESSAGE_MAX_LENGTH } from "./constants";
import { EmbedSchema, MAX_URL_LENGTH } from "./embed";

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
