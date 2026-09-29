import * as v from "valibot";
import { CHAT_MAX_LENGTH, ERROR_MESSAGE_MAX_LENGTH, MAX_MESSAGE_BYTES } from "./constants";
import { EmbedSchema } from "./embed";
import {
  AvatarSchema,
  MemberIdSchema,
  MemberSchema,
  NicknameSchema,
  RoomStateSchema,
  SeatIndexSchema,
} from "./room";

/** Trimmed, 1–280 chars, no control or bidi-override characters. Emoji are fine. */
export const ChatTextSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(CHAT_MAX_LENGTH),
  v.regex(/^[^\p{Cc}\u202A-\u202E\u2066-\u2069]*$/u),
);

// Client → server. Strict: unknown keys are rejected, not stripped.
export const ClientMessageSchema = v.variant("type", [
  v.strictObject({ type: v.literal("join"), nickname: NicknameSchema, avatar: AvatarSchema }),
  v.strictObject({ type: v.literal("leave") }),
  /** `seat: null` stands up. */
  v.strictObject({ type: v.literal("sit"), seat: v.nullable(SeatIndexSchema) }),
  v.strictObject({ type: v.literal("chat"), text: ChatTextSchema }),
]);
export type ClientMessage = v.InferOutput<typeof ClientMessageSchema>;

export const ERROR_CODES = ["bad_message", "not_joined", "already_joined", "seat_taken", "rate_limited"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// Server → client. Unknown keys are stripped so the server can add fields.
export const ServerMessageSchema = v.variant("type", [
  /** First message after a successful join. */
  v.object({ type: v.literal("snapshot"), self: MemberIdSchema, room: RoomStateSchema }),
  v.object({ type: v.literal("member-joined"), member: MemberSchema }),
  v.object({ type: v.literal("member-left"), memberId: MemberIdSchema }),
  v.object({ type: v.literal("seat-changed"), memberId: MemberIdSchema, seat: v.nullable(SeatIndexSchema) }),
  v.object({
    type: v.literal("chat"),
    memberId: MemberIdSchema,
    text: ChatTextSchema,
    /** Server time, ms since epoch. */
    at: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  /** `by` is null when the embed came from `POST /rooms/:id/share`. */
  v.object({ type: v.literal("embed-changed"), embed: v.nullable(EmbedSchema), by: v.nullable(MemberIdSchema) }),
  /** Sent instead of a snapshot when the room is at MAX_ROOM_MEMBERS; the server then closes. */
  v.object({ type: v.literal("room-full") }),
  v.object({
    type: v.literal("error"),
    code: v.picklist(ERROR_CODES),
    message: v.pipe(v.string(), v.maxLength(ERROR_MESSAGE_MAX_LENGTH)),
  }),
]);
export type ServerMessage = v.InferOutput<typeof ServerMessageSchema>;

const encoder = new TextEncoder();

function withinFrameLimit(raw: string): boolean {
  // Each UTF-16 unit is 1–3 UTF-8 bytes, so only encode when the answer is unclear.
  if (raw.length > MAX_MESSAGE_BYTES) return false;
  if (raw.length * 3 <= MAX_MESSAGE_BYTES) return true;
  return encoder.encode(raw).byteLength <= MAX_MESSAGE_BYTES;
}

function parseFrame<T extends v.GenericSchema>(schema: T, raw: string): v.InferOutput<T> | null {
  if (!withinFrameLimit(raw)) return null;
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
  return parseFrame(ClientMessageSchema, raw);
}

/** Boundary parser for frames the client receives. Never throws. */
export function parseServerMessage(raw: string): ServerMessage | null {
  return parseFrame(ServerMessageSchema, raw);
}
