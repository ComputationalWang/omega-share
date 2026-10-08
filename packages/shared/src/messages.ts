import * as v from "valibot";
import {
  CHAT_MAX_LENGTH,
  CHAT_MAX_MARK_RUN,
  ERROR_MESSAGE_MAX_LENGTH,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_EMBED_URL_LENGTH,
  MAX_SERVER_MESSAGE_BYTES,
} from "./constants";
import { AnyEmbedSchema, playbackMatchesEmbed } from "./generic-embed";
import { OptionalPlaybackSchema, PingIdSchema, PlaybackStateSchema, PositionSchema, ServerTimeSchema } from "./playback";
import {
  AvatarSchema,
  INVISIBLE_LETTERS,
  MemberIdSchema,
  MemberSchema,
  NicknameSchema,
  RoomStateSchema,
  RoomTitleSchema,
  SeatIndexSchema,
} from "./room";
import { RoomLayoutInputSchema, RoomLayoutSchema } from "./layout";
import { InviteKeySchema, OwnerTokenSchema } from "./room-ownership";
import { RetryAfterMsSchema, ShareTokenSchema } from "./share";

/** Anything but controls, format characters (zero-width, bidi, BOM) and line/paragraph separators. */
const CHAT_CHAR = String.raw`[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]`;
/** ZWJ only inside an emoji sequence: pictograph (+ marks/skin tone), ZWJ, pictograph. */
const CHAT_ZWJ = String.raw`(?<=\p{Extended_Pictographic}[\p{M}\u{1F3FB}-\u{1F3FF}]*)\u200D(?=\p{Extended_Pictographic})`;
const CHAT_SHAPE = new RegExp(`^(?:${CHAT_CHAR}|${CHAT_ZWJ})*$`, "u");
const CHAT_MARK_STACK = new RegExp(String.raw`\p{M}{${String(CHAT_MAX_MARK_RUN + 1)}}`, "u");

/**
 * Trimmed and NFC-normalized, 1–280 chars. No control, format (zero-width, bidi, BOM) or
 * line/paragraph separator characters, except ZWJ inside emoji sequences. At most 3
 * combining marks in a row. Must contain something visible.
 */
export const ChatTextSchema = v.pipe(
  v.string(),
  v.trim(),
  v.normalize("NFC"),
  v.minLength(1),
  v.maxLength(CHAT_MAX_LENGTH),
  v.regex(CHAT_SHAPE),
  v.check((s) => !CHAT_MARK_STACK.test(s), "too many combining marks"),
  v.check((s) => !INVISIBLE_LETTERS.test(s), "invisible characters"),
  v.regex(/[\p{L}\p{N}\p{P}\p{S}]/u, "nothing visible"),
);

// Client → server. Strict: unknown keys are rejected, not stripped.
export const ClientMessageSchema = v.variant("type", [
  /**
   * `ownerToken` makes this member the room's owner if it matches (a wrong one joins as a guest).
   * A private room needs a matching `inviteKey` or `ownerToken`, else `error: invite_required` (ADR 0028).
   */
  v.strictObject({
    type: v.literal("join"),
    nickname: NicknameSchema,
    avatar: AvatarSchema,
    ownerToken: v.optional(OwnerTokenSchema),
    inviteKey: v.optional(InviteKeySchema),
  }),
  v.strictObject({ type: v.literal("leave") }),
  /** `seat: null` stands up. */
  v.strictObject({ type: v.literal("sit"), seat: v.nullable(SeatIndexSchema) }),
  v.strictObject({ type: v.literal("chat"), text: ChatTextSchema }),
  /** Clock sample; allowed before `join`. Answered with `pong` to the sender only. */
  v.strictObject({ type: v.literal("ping"), id: PingIdSchema }),
  /**
   * Desired room playback. Seek while playing = `{ playing: true, position }`.
   * Needs `join`; `url` must equal the current synced `embed.url`, else `error: no_embed`
   * (a generic embed is never synced, ADR 0024).
   * For a live embed (`playbackCaps(embed).live`) the server ignores `position`.
   */
  v.strictObject({
    type: v.literal("control"),
    url: v.pipe(v.string(), v.maxLength(MAX_EMBED_URL_LENGTH)),
    playing: v.boolean(),
    position: PositionSchema,
  }),
  /**
   * Advisory catch-up flag (ADR 0019); never pauses the room. Needs `join`. Send only on
   * change, after it has held for 500 ms (web `CATCHUP_SHOW_MS`). Counts against the per-socket frame limit.
   */
  v.strictObject({ type: v.literal("status"), catching: v.boolean() }),
  /** Owner only (`not_owner` otherwise): replace the room's whole layout. Last write wins; seats keep their indices (ADR 0028). */
  v.strictObject({ type: v.literal("layout-set"), layout: RoomLayoutInputSchema }),
  /** Owner only (`not_owner` otherwise): rename the room. */
  v.strictObject({ type: v.literal("title-set"), title: RoomTitleSchema }),
]);
export type ClientMessage = v.InferOutput<typeof ClientMessageSchema>;

export const ERROR_CODES = [
  "bad_message",
  "not_joined",
  "already_joined",
  "seat_taken",
  /** Carries `retryAfterMs` from M3 servers. */
  "rate_limited",
  "no_embed",
  /** `join` refused: another member's `nicknameKey` matches. The socket stays open, unjoined. */
  "nickname_taken",
  /** `join` refused: too many members from this address in the room. The socket stays open, unjoined. */
  "too_many_members",
  /** `join` to a private room without a matching `inviteKey` or `ownerToken`. The socket stays open, unjoined. */
  "invite_required",
  /** `layout-set` or `title-set` from a member who didn't join with the owner token. */
  "not_owner",
] as const;
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
    /** True when this member joined with the room's owner token; only in their own snapshot (ADR 0028). */
    owner: v.optional(v.boolean()),
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
   * null or generic, ADR 0024; absent from pre-M1b servers).
   */
  v.pipe(
    v.object({
      type: v.literal("embed-changed"),
      embed: v.nullable(AnyEmbedSchema),
      by: v.nullable(MemberIdSchema),
      playback: OptionalPlaybackSchema,
    }),
    v.check((x) => playbackMatchesEmbed(x), "playback without a synced embed"),
  ),
  /** A member's `catching` changed. Coalesced by the server; the latest value always arrives. */
  v.object({ type: v.literal("member-status"), memberId: MemberIdSchema, catching: v.boolean() }),
  /** Reply to `ping`. `at` = server ms when it answered. */
  v.object({ type: v.literal("pong"), id: PingIdSchema, at: ServerTimeSchema }),
  /** The room's playback changed; published to every member. */
  v.object({ type: v.literal("playback"), playback: PlaybackStateSchema }),
  /** The owner replaced the layout. Seats keep their indices: draw seat `i` at the new `i`-th seat cell. */
  v.object({ type: v.literal("layout-changed"), layout: RoomLayoutSchema, by: MemberIdSchema }),
  /** The owner renamed the room. */
  v.object({ type: v.literal("title-changed"), title: RoomTitleSchema, by: MemberIdSchema }),
  /** Sent instead of a snapshot when the room is at MAX_ROOM_MEMBERS; the server then closes. */
  v.object({ type: v.literal("room-full") }),
  v.object({
    type: v.literal("error"),
    code: v.picklist(ERROR_CODES),
    message: v.pipe(v.string(), v.maxLength(ERROR_MESSAGE_MAX_LENGTH)),
    /** Set with `rate_limited`: wait this long before retrying. */
    retryAfterMs: v.optional(RetryAfterMsSchema),
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
