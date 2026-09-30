import * as v from "valibot";
import { AVATAR_COUNT, MAX_ROOM_MEMBERS, NICKNAME_MAX_LENGTH, SEAT_COUNT } from "./constants";
import { EmbedSchema } from "./embed";
import { MemberIdSchema } from "./ids";
import { OptionalPlaybackSchema } from "./playback";

export const RoomIdSchema = v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,32}$/));
export type RoomId = v.InferOutput<typeof RoomIdSchema>;

export { MemberIdSchema, type MemberId } from "./ids";

/** Letters that render as blank space (Hangul fillers). */
export const INVISIBLE_LETTERS = /[\u115F\u1160\u3164\uFFA0]/u;

/**
 * Trimmed and NFC-normalized, then 1–20 UTF-16 units of letters (with combining
 * marks), digits, `_ . -`, with single spaces between words. No emoji, controls
 * or invisible characters.
 */
export const NicknameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.normalize("NFC"),
  v.minLength(1),
  v.maxLength(NICKNAME_MAX_LENGTH),
  v.regex(/^(?:[\p{L}\p{N}_.-]\p{M}*)+(?: (?:[\p{L}\p{N}_.-]\p{M}*)+)*$/u),
  v.check((s) => !INVISIBLE_LETTERS.test(s), "invisible characters"),
);
export type Nickname = v.InferOutput<typeof NicknameSchema>;

export const AvatarSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(AVATAR_COUNT - 1));
export type Avatar = v.InferOutput<typeof AvatarSchema>;

export const SeatIndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(SEAT_COUNT - 1));
export type SeatIndex = v.InferOutput<typeof SeatIndexSchema>;

export const MemberSchema = v.object({
  id: MemberIdSchema,
  nickname: NicknameSchema,
  avatar: AvatarSchema,
});
export type Member = v.InferOutput<typeof MemberSchema>;

export const RoomStateSchema = v.pipe(
  v.object({
    id: RoomIdSchema,
    /** Always SEAT_COUNT long; `seats[i]` is the occupant's member id or null. */
    seats: v.pipe(v.array(v.nullable(MemberIdSchema)), v.length(SEAT_COUNT)),
    members: v.pipe(v.array(MemberSchema), v.maxLength(MAX_ROOM_MEMBERS)),
    embed: v.nullable(EmbedSchema),
    /** Null iff `embed` is null. Absent only from a pre-M1b server (treat as null). */
    playback: OptionalPlaybackSchema,
  }),
  v.check((x) => x.embed !== null || (x.playback ?? null) === null, "playback without embed"),
  v.check((r) => new Set(r.members.map((m) => m.id)).size === r.members.length, "duplicate member id"),
  v.check((r) => {
    const ids = new Set(r.members.map((m) => m.id));
    const seated = r.seats.filter((s) => s !== null);
    return new Set(seated).size === seated.length && seated.every((s) => ids.has(s));
  }, "seat occupants must be distinct members"),
);
export type RoomState = v.InferOutput<typeof RoomStateSchema>;
