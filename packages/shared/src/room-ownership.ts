import * as v from "valibot";
import { ERROR_MESSAGE_MAX_LENGTH, ROOM_CREATE_RETRY_AFTER_MAX_MS } from "./constants";
import { RoomIdSchema, RoomTitleSchema } from "./room";
import { RetryAfterMsSchema, SHARE_TOKEN_LENGTH, ShareTokenSchema } from "./share";

/**
 * Created rooms (ADR 0028): `POST /rooms`, `DELETE /rooms/:id`, the owner token, the private-room
 * invite key and the site's record of both.
 */

/**
 * Bearer secret for a room's owner: 16 random bytes as base64url (the share-token shape). Minted
 * once, in the `POST /rooms` 201 body. Never in a URL, snapshot, broadcast or log; the server
 * keeps only its SHA-256.
 */
export const OwnerTokenSchema = ShareTokenSchema;
export type OwnerToken = v.InferOutput<typeof OwnerTokenSchema>;

/**
 * Key that admits a joiner to a private room, same shape as the owner token. It travels only in
 * the invite link's fragment, `/r/<id>#k=<key>`, and in `join.inviteKey`; the server keeps its SHA-256.
 */
export const InviteKeySchema = ShareTokenSchema;
export type InviteKey = v.InferOutput<typeof InviteKeySchema>;

const INVITE_HASH = /^#k=([A-Za-z0-9_-]{22})$/;

/** The key in a `location.hash` of exactly `#k=<key>`, else null. Never throws. */
export function inviteKeyFromHash(hash: string): InviteKey | null {
  // Bounds the regex input; a valid hash is exactly "#k=" + 22 chars.
  if (hash.length !== 3 + SHARE_TOKEN_LENGTH) return null;
  return INVITE_HASH.exec(hash)?.[1] ?? null;
}

/** Fixed at creation: private rooms are never listed and need an invite key to join. */
export const RoomVisibilitySchema = v.picklist(["public", "private"]);
export type RoomVisibility = v.InferOutput<typeof RoomVisibilitySchema>;

/** Body of `POST /rooms`, at most `MAX_CREATE_BODY_BYTES`. The server picks the id and starts from `DEFAULT_LAYOUT`. */
export const CreateRoomRequestSchema = v.strictObject({ title: RoomTitleSchema, visibility: RoomVisibilitySchema });
export type CreateRoomRequest = v.InferOutput<typeof CreateRoomRequestSchema>;

export const CREATE_ROOM_ERROR_CODES = [
  "invalid_body",
  /** HTTP 413. */
  "payload_too_large",
  /** HTTP 429 with `Retry-After`. */
  "rate_limited",
  /** HTTP 503: `MAX_ROOMS` reached. The server refuses; it never evicts a room. */
  "too_many_rooms",
  /** HTTP 503: the server couldn't save the room. Nothing was created; try again later. */
  "unavailable",
] as const;
export type CreateRoomErrorCode = (typeof CREATE_ROOM_ERROR_CODES)[number];

export const DELETE_ROOM_ERROR_CODES = [
  "room_not_found",
  /** Missing or malformed bearer, or not this room's owner token. HTTP 401. */
  "unauthorized",
  "rate_limited",
  /** HTTP 503: the server couldn't delete the stored room. The room stays; try again later. */
  "unavailable",
] as const;
export type DeleteRoomErrorCode = (typeof DELETE_ROOM_ERROR_CODES)[number];

const failure = <const C extends readonly [string, ...string[]]>(codes: C, retryAfterMs: v.GenericSchema<number> = RetryAfterMsSchema) =>
  v.object({
    ok: v.literal(false),
    error: v.object({
      code: v.picklist(codes),
      message: v.pipe(v.string(), v.maxLength(ERROR_MESSAGE_MAX_LENGTH)),
      /** With `rate_limited`. */
      retryAfterMs: v.optional(retryAfterMs),
    }),
  });

/** Answer to `POST /rooms`: 201 with the room and its secrets, or an error. */
export const CreateRoomResponseSchema = v.variant("ok", [
  v.pipe(
    v.object({
      ok: v.literal(true),
      room: v.object({ id: RoomIdSchema, title: RoomTitleSchema, visibility: RoomVisibilitySchema }),
      ownerToken: OwnerTokenSchema,
      /** Private rooms only. */
      inviteKey: v.optional(InviteKeySchema),
    }),
    v.check((r) => (r.inviteKey !== undefined) === (r.room.visibility === "private"), "invite key iff private"),
  ),
  // A creation 429 may wait out the key bucket's full 10 min refill.
  failure(CREATE_ROOM_ERROR_CODES, v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(ROOM_CREATE_RETRY_AFTER_MAX_MS))),
]);
export type CreateRoomResponse = v.InferOutput<typeof CreateRoomResponseSchema>;

/** Answer to `DELETE /rooms/:id` with `Authorization: Bearer <ownerToken>`. */
export const DeleteRoomResponseSchema = v.variant("ok", [v.object({ ok: v.literal(true) }), failure(DELETE_ROOM_ERROR_CODES)]);
export type DeleteRoomResponse = v.InferOutput<typeof DeleteRoomResponseSchema>;

/**
 * `localStorage` key for the site's owner tokens and invite keys. Unlike the share record it
 * outlives the tab. The extension must never read it.
 */
export const ROOM_SECRETS_STORAGE_KEY = "omega.rooms";
/** Most rooms kept at `ROOM_SECRETS_STORAGE_KEY`; the site drops the oldest first. */
export const MAX_ROOM_SECRETS = 50;

/** Value at `ROOM_SECRETS_STORAGE_KEY`, after `JSON.parse`. */
export const RoomSecretsSchema = v.strictObject({
  v: v.literal(1),
  rooms: v.pipe(
    v.record(RoomIdSchema, v.strictObject({ ownerToken: v.optional(OwnerTokenSchema), inviteKey: v.optional(InviteKeySchema) })),
    v.check((r) => Object.keys(r).length <= MAX_ROOM_SECRETS, "too many rooms"),
  ),
});
export type RoomSecrets = v.InferOutput<typeof RoomSecretsSchema>;
