import * as v from "valibot";
import {
  AVATAR_COUNT,
  MAX_ROOM_MEMBERS,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MAX_MARK_RUN,
  ROOM_ID_MAX_LENGTH,
  SEAT_COUNT,
} from "./constants";
import { EmbedSchema } from "./embed";
import { MemberIdSchema } from "./ids";
import { OptionalPlaybackSchema } from "./playback";

export const RoomIdSchema = v.pipe(v.string(), v.regex(new RegExp(`^[a-z0-9-]{1,${String(ROOM_ID_MAX_LENGTH)}}$`)));
export type RoomId = v.InferOutput<typeof RoomIdSchema>;

export { MemberIdSchema, type MemberId } from "./ids";

/** Letters that render as blank space (Hangul fillers). */
export const INVISIBLE_LETTERS = /[\u115F\u1160\u3164\uFFA0]/u;

const NICKNAME_WORD = `(?:[\\p{L}\\p{N}_.-]\\p{M}{0,${String(NICKNAME_MAX_MARK_RUN)}})+`;
const NICKNAME_SHAPE = new RegExp(`^${NICKNAME_WORD}(?: ${NICKNAME_WORD})*$`, "u");
const LATIN = /\p{Script=Latin}/u;
/** Scripts with letters that pass for Latin ones ("Аlice" with a Cyrillic А). */
const LATIN_LOOKALIKES = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;

/**
 * NFKC-normalized (folds fullwidth and compatibility forms), then trimmed, then 1–20
 * UTF-16 units of letters (each with at most 2 combining marks), digits, `_ . -`, with
 * single spaces between words. No emoji, controls, bidi or zero-width characters: they
 * are rejected, not stripped. Latin letters never mix with Cyrillic, Greek, Armenian or
 * Cherokee ones. Full confusables matching (UTS #39) is M4 (ADR 0016).
 */
export const NicknameSchema = v.pipe(
  v.string(),
  v.normalize("NFKC"),
  v.trim(),
  v.minLength(1),
  v.maxLength(NICKNAME_MAX_LENGTH),
  v.regex(NICKNAME_SHAPE),
  v.check((s) => !INVISIBLE_LETTERS.test(s), "invisible characters"),
  v.check((s) => !(LATIN.test(s) && LATIN_LOOKALIKES.test(s)), "mixed scripts"),
);
export type Nickname = v.InferOutput<typeof NicknameSchema>;

/** The nickname `NicknameSchema` makes of `input`, or null if it has none. Never throws. */
export function normalizeNickname(input: unknown): Nickname | null {
  const result = v.safeParse(NicknameSchema, input);
  return result.success ? result.output : null;
}

/**
 * Uniqueness key: two members of a room may not share one. Case-, width- and
 * accent-insensitive, so "José" and "jose" collide (deliberately conservative).
 */
export function nicknameKey(nickname: Nickname): string {
  return nickname.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

export const AvatarSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(AVATAR_COUNT - 1));
export type Avatar = v.InferOutput<typeof AvatarSchema>;

export const SeatIndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(SEAT_COUNT - 1));
export type SeatIndex = v.InferOutput<typeof SeatIndexSchema>;

export const MemberSchema = v.object({
  id: MemberIdSchema,
  nickname: NicknameSchema,
  avatar: AvatarSchema,
  /** Advisory: this member's player is catching up (ADR 0019). Absent means false. */
  catching: v.optional(v.boolean()),
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
