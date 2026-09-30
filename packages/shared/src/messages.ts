import * as v from "valibot";
import { CHAT_MAX_LENGTH, ERROR_MESSAGE_MAX_LENGTH, MAX_CLIENT_MESSAGE_BYTES, MAX_SERVER_MESSAGE_BYTES } from "./constants";
import { EmbedSchema, YoutubeVideoIdSchema } from "./embed";
import { OptionalPlaybackSchema, PingIdSchema, PlaybackStateSchema, PositionSchema, ServerTimeSchema } from "./playback";
import {
  AvatarSchema,
  INVISIBLE_LETTERS,
  MemberIdSchema,
  MemberSchema,
  NicknameSchema,
  RoomStateSchema,
  SeatIndexSchema,
} from "./room";
import { ShareTokenSchema } from "./share";

/**
 * Trimmed, 1–280 chars. No control, format (zero-width, bidi, BOM) or line/paragraph
 * separator characters, except ZWJ for emoji sequences. Must contain something visible.
 */
export const ChatTextSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(CHAT_MAX_LENGTH),
  v.regex(/^(?:[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\u200D)*$/u),
  v.check((s) => !INVISIBLE_LETTERS.test(s), "invisible characters"),
  v.regex(/[\p{L}\p{N}\p{P}\p{S}]/u, "nothing visible"),
);

// Client → server. Strict: unknown keys are rejected, not stripped.
export const ClientMessageSchema = v.variant("type", [
  v.strictObject({ type: v.literal("join"), nickname: NicknameSchema, avatar: AvatarSchema }),
  v.strictObject({ type: v.literal("leave") }),
  /** `seat: null` stands up. */
  v.strictObject({ type: v.literal("sit"), seat: v.nullable(SeatIndexSchema) }),
  v.strictObject({ type: v.literal("chat"), text: ChatTextSchema }),
  /** Clock sample; allowed before `join`. Answered with `pong` to the sender only. */
  v.strictObject({ type: v.literal("ping"), id: PingIdSchema }),
  /**
   * Desired room playback. Seek while playing = `{ playing: true, position }`.
   * Needs `join`; `videoId` must match the current embed, else `error: no_embed`.
   */
  v.strictObject({ type: v.literal("control"), videoId: YoutubeVideoIdSchema, playing: v.boolean(), position: PositionSchema }),
]);
export type ClientMessage = v.InferOutput<typeof ClientMessageSchema>;

export const ERROR_CODES = ["bad_message", "not_joined", "already_joined", "seat_taken", "rate_limited", "no_embed"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// Server → client. Unknown keys are stripped so the server can add fields.
export const ServerMessageSchema = v.variant("type", [
  /**
   * First message after a successful join. `shareToken` authorizes this member's
   * `POST /rooms/:id/share` until they leave; it is never broadcast (absent from pre-M2 servers).
   */
  v.object({
    type: v.literal("snapshot"),
    self: MemberIdSchema,
    room: RoomStateSchema,
    shareToken: v.optional(ShareTokenSchema),
  }),
  v.object({ type: v.literal("member-joined"), member: MemberSchema }),
  v.object({ type: v.literal("member-left"), memberId: MemberIdSchema }),
  v.object({ type: v.literal("seat-changed"), memberId: MemberIdSchema, seat: v.nullable(SeatIndexSchema) }),
  v.object({
    type: v.literal("chat"),
    memberId: MemberIdSchema,
    text: ChatTextSchema,
    /** Server time, ms since epoch. */
    at: ServerTimeSchema,
  }),
  /**
   * `by` is the member who shared it; null means server-initiated (or a pre-M2 server's
   * anonymous share). `playback` is the new embed's `load` state (null iff `embed` is
   * null; absent from pre-M1b servers).
   */
  v.pipe(
    v.object({
      type: v.literal("embed-changed"),
      embed: v.nullable(EmbedSchema),
      by: v.nullable(MemberIdSchema),
      playback: OptionalPlaybackSchema,
    }),
    v.check((x) => x.embed !== null || (x.playback ?? null) === null, "playback without embed"),
  ),
  /** Reply to `ping`. `at` = server ms when it answered. */
  v.object({ type: v.literal("pong"), id: PingIdSchema, at: ServerTimeSchema }),
  /** The room's playback changed; published to every member. */
  v.object({ type: v.literal("playback"), playback: PlaybackStateSchema }),
  /** Sent instead of a snapshot when the room is at MAX_ROOM_MEMBERS; the server then closes. */
  v.object({ type: v.literal("room-full") }),
  v.object({
    type: v.literal("error"),
    code: v.picklist(ERROR_CODES),
    message: v.pipe(v.string(), v.maxLength(ERROR_MESSAGE_MAX_LENGTH)),
  }),
]);
export type ServerMessage = v.InferOutput<typeof ServerMessageSchema>;

/** UTF-8 length of `raw` is at most `max`. Allocation-free; stops early. */
function withinFrameLimit(raw: string, max: number): boolean {
  // Each UTF-16 unit is 1–3 UTF-8 bytes (a surrogate pair is 2 units → 4 bytes).
  if (raw.length > max) return false;
  if (raw.length * 3 <= max) return true;
  let bytes = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 || (c >= 0xd800 && c < 0xe000) ? 2 : 3;
    if (bytes > max) return false;
  }
  return true;
}

function parseFrame<T extends v.GenericSchema>(schema: T, raw: string, max: number): v.InferOutput<T> | null {
  if (!withinFrameLimit(raw, max)) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = v.safeParse(schema, json);
  return result.success ? result.output : null;
}

/** Boundary parser for frames the server receives. Never throws. */
export function parseClientMessage(raw: string): ClientMessage | null {
  return parseFrame(ClientMessageSchema, raw, MAX_CLIENT_MESSAGE_BYTES);
}

/** Boundary parser for frames the client receives. Never throws. */
export function parseServerMessage(raw: string): ServerMessage | null {
  return parseFrame(ServerMessageSchema, raw, MAX_SERVER_MESSAGE_BYTES);
}
