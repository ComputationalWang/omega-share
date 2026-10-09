import * as v from "valibot";
import {
  AVATAR_COUNT,
  MAX_ROOM_MEMBERS,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MAX_MARK_RUN,
  ROOM_ID_MAX_LENGTH,
  ROOM_TITLE_MAX_LENGTH,
  SEAT_COUNT,
} from "./constants";
import { AnyEmbedSchema, playbackMatchesEmbed } from "./generic-embed";
import { MemberIdSchema, QueueItemIdSchema } from "./ids";
import { RoomLayoutSchema } from "./layout";
import { OptionalPlaybackSchema } from "./playback";
import { QueueSchema } from "./queue";

export const RoomIdSchema = v.pipe(v.string(), v.regex(new RegExp(`^[a-z0-9-]{1,${String(ROOM_ID_MAX_LENGTH)}}$`)));
export type RoomId = v.InferOutput<typeof RoomIdSchema>;

export { MemberIdSchema, type MemberId } from "./ids";

/** Letters that render as blank space (Hangul fillers). */
export const INVISIBLE_LETTERS = /[\u115F\u1160\u3164\uFFA0]/u;

/** A word: letters (each with at most 2 combining marks), digits and `chars`. */
const nameShape = (chars: string): RegExp => {
  const word = `(?:[\\p{L}\\p{N}${chars}]\\p{M}{0,${String(NICKNAME_MAX_MARK_RUN)}})+`;
  return new RegExp(`^${word}(?: ${word})*$`, "u");
};
const LATIN = /\p{Script=Latin}/u;
/** Scripts with letters that pass for Latin ones ("Аlice" with a Cyrillic А). */
const LATIN_LOOKALIKES = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;

/** NFKC → trim → 1..`max` units of `shape`; no invisible letters; Latin never mixed with its lookalikes. */
const nameSchema = (max: number, shape: RegExp) =>
  v.pipe(
    v.string(),
    v.normalize("NFKC"),
    v.trim(),
    v.minLength(1),
    v.maxLength(max),
    v.regex(shape),
    v.check((s) => !INVISIBLE_LETTERS.test(s), "invisible characters"),
    v.check((s) => !(LATIN.test(s) && LATIN_LOOKALIKES.test(s)), "mixed scripts"),
  );

/**
 * NFKC-normalized (folds fullwidth and compatibility forms), then trimmed, then 1–20
 * UTF-16 units of letters (each with at most 2 combining marks), digits, `_ . -`, with
 * single spaces between words. No emoji, controls, bidi or zero-width characters: they
 * are rejected, not stripped. Latin letters never mix with Cyrillic, Greek, Armenian or
 * Cherokee ones. Full confusables matching (UTS #39) is the uniqueness key in
 * `@omega/shared/confusables` (ADR 0023).
 */
export const NicknameSchema = nameSchema(NICKNAME_MAX_LENGTH, nameShape("_.\\-"));
export type Nickname = v.InferOutput<typeof NicknameSchema>;

/** The nickname `NicknameSchema` makes of `input`, or null if it has none. Never throws. */
export function normalizeNickname(input: unknown): Nickname | null {
  const result = v.safeParse(NicknameSchema, input);
  return result.success ? result.output : null;
}

/** Variation selectors and the combining keycap: the marks that turn text into emoji. */
const EMOJI_MARKS = /[\uFE0E\uFE0F\u20E3]/u;

/**
 * A room's name (ADR 0028). It is listed publicly, so it gets the nickname rules, 1–32 units, plus
 * the punctuation a title needs: `' ! ? & , : # + ( )`. No `<`, `>`, `/` or quotes; still rendered as text only.
 */
export const RoomTitleSchema = v.pipe(
  nameSchema(ROOM_TITLE_MAX_LENGTH, nameShape("_.\\-'!?&,:#+()")),
  // Keycaps ("#️⃣", "1️⃣") are a base plus combining marks, so the word shape alone lets them through.
  v.check((s) => !EMOJI_MARKS.test(s), "emoji"),
);
export type RoomTitle = v.InferOutput<typeof RoomTitleSchema>;

export const AvatarSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(AVATAR_COUNT - 1));
export type Avatar = v.InferOutput<typeof AvatarSchema>;

export const SeatIndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(SEAT_COUNT - 1));
export type SeatIndex = v.InferOutput<typeof SeatIndexSchema>;

/**
 * Who may send `control` frames and shares (ADR 0030). `owner`: only members who joined with the
 * owner token. New and seeded rooms start at DEFAULT_CONTROL_POLICY.
 */
export const CONTROL_POLICIES = ["everyone", "owner"] as const;
export const ControlPolicySchema = v.picklist(CONTROL_POLICIES);
export type ControlPolicy = v.InferOutput<typeof ControlPolicySchema>;
/** Today's behaviour: anyone in the room controls playback (open board default, ADR 0030). */
export const DEFAULT_CONTROL_POLICY: ControlPolicy = "everyone";

export const MemberSchema = v.object({
  id: MemberIdSchema,
  nickname: NicknameSchema,
  avatar: AvatarSchema,
  /** Advisory: this member's player is catching up (ADR 0019). Absent means false. */
  catching: v.optional(v.boolean()),
  /** The owner muted this member's chat (ADR 0030). Absent means false. */
  muted: v.optional(v.boolean()),
});
export type Member = v.InferOutput<typeof MemberSchema>;

export const RoomStateSchema = v.pipe(
  v.object({
    id: RoomIdSchema,
    /** The room's name (ADR 0028). Absent when it has none, or from a pre-M5 server: learn it from `title-changed`. */
    title: v.optional(RoomTitleSchema),
    /** Always SEAT_COUNT long; `seats[i]` is the occupant's member id or null. */
    seats: v.pipe(v.array(v.nullable(MemberIdSchema)), v.length(SEAT_COUNT)),
    members: v.pipe(v.array(MemberSchema), v.maxLength(MAX_ROOM_MEMBERS)),
    embed: v.nullable(AnyEmbedSchema),
    /** Null iff `embed` is null or generic (ADR 0024). Absent only from a pre-M1b server (treat as null). */
    playback: OptionalPlaybackSchema,
    /** The room's furniture (ADR 0021). Absent from a pre-M4 server: draw DEFAULT_LAYOUT. */
    layout: v.optional(RoomLayoutSchema),
    /** Who controls playback (ADR 0030). Absent from a pre-M6 server: DEFAULT_CONTROL_POLICY. */
    controlPolicy: v.optional(ControlPolicySchema),
    /** The current embed's queue item id, for `ended` and `queue-advance` (ADR 0031). Absent with no embed, or from a pre-M6 server. */
    itemId: v.optional(QueueItemIdSchema),
    /** Upcoming items (ADR 0031), not counting the current one. Absent from a pre-M6 server: empty. */
    queue: v.optional(QueueSchema),
  }),
  v.check((r) => r.itemId === undefined || r.embed !== null, "item id without an embed"),
  v.check((r) => r.itemId === undefined || !(r.queue ?? []).some((i) => i.id === r.itemId), "current item also queued"),
  v.check((x) => playbackMatchesEmbed(x), "playback without a synced embed"),
  v.check((r) => new Set(r.members.map((m) => m.id)).size === r.members.length, "duplicate member id"),
  v.check((r) => {
    const ids = new Set(r.members.map((m) => m.id));
    const seated = r.seats.filter((s) => s !== null);
    return new Set(seated).size === seated.length && seated.every((s) => ids.has(s));
  }, "seat occupants must be distinct members"),
);
export type RoomState = v.InferOutput<typeof RoomStateSchema>;
