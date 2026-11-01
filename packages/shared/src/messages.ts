import * as v from "valibot";
import {
  BATCH_MAX_MESSAGES,
  CHAT_MAX_LENGTH,
  CHAT_MAX_MARK_RUN,
  CONGA_CAP,
  DICE_MAX_SIDES,
  DICE_MIN_SIDES,
  ERROR_MESSAGE_MAX_LENGTH,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_ROOM_MEMBERS,
  MAX_URL_LENGTH,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_LENGTH,
  POLL_QUESTION_MAX_LENGTH,
  REACTIONS_MAX,
} from "./constants";
import { PollIdSchema, RoomIdSchema } from "./ids";
import { AnyEmbedSchema, MAX_GENERIC_EMBED_URL_LENGTH, playbackMatchesEmbed } from "./generic-embed";
import { MediaMsSchema, OptionalPlaybackSchema, PingIdSchema, PlaybackStateSchema, PositionSchema, ServerTimeSchema } from "./playback";
import {
  AvatarSchema,
  AccessorySchema,
  HairSchema,
  ControlPolicySchema,
  INVISIBLE_LETTERS,
  MemberIdSchema,
  MemberSchema,
  NicknameSchema,
  RoomStateSchema,
  RoomTitleSchema,
  SeatIndexSchema,
  SleeperSchema,
  TintSchema,
} from "./room";
import { FloorCellInputSchema, FloorCellSchema, PieceIndexSchema, RoomLayoutInputSchema, RoomLayoutSchema } from "./layout";
import { QueueIndexSchema, QueueItemIdSchema, QueueSchema } from "./queue";
import { InviteKeySchema, OwnerTokenSchema } from "./room-ownership";
import { RetryAfterMsSchema, ShareTokenSchema } from "./share";
import { ResumeTokenSchema } from "./session";

/** Anything but controls, format characters (zero-width, bidi, BOM) and line/paragraph separators. */
const CHAT_CHAR = String.raw`[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]`;
/** ZWJ only inside an emoji sequence: pictograph (+ marks/skin tone), ZWJ, pictograph. */
const CHAT_ZWJ = String.raw`(?<=\p{Extended_Pictographic}[\p{M}\u{1F3FB}-\u{1F3FF}]*)\u200D(?=\p{Extended_Pictographic})`;
const CHAT_SHAPE = new RegExp(`^(?:${CHAT_CHAR}|${CHAT_ZWJ})*$`, "u");
const CHAT_MARK_STACK = new RegExp(String.raw`\p{M}{${String(CHAT_MAX_MARK_RUN + 1)}}`, "u");

/**
 * Trimmed and NFC-normalized, 1–`maxLength` chars. No control, format (zero-width, bidi, BOM) or
 * line/paragraph separator characters, except ZWJ inside emoji sequences. At most 3
 * combining marks in a row. Must contain something visible. Chat's rules, shared with report notes (ADR 0033).
 */
export const plainTextSchema = (maxLength: number) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.normalize("NFC"),
    v.minLength(1),
    v.maxLength(maxLength),
    v.regex(CHAT_SHAPE),
    v.check((s) => !CHAT_MARK_STACK.test(s), "too many combining marks"),
    v.check((s) => !INVISIBLE_LETTERS.test(s), "invisible characters"),
    v.regex(/[\p{L}\p{N}\p{P}\p{S}]/u, "nothing visible"),
  );

/** `plainTextSchema` at 1–280 chars. */
export const ChatTextSchema = plainTextSchema(CHAT_MAX_LENGTH);

/** A die's faces, DICE_MIN_SIDES..DICE_MAX_SIDES (OME-1423). */
export const DiceSidesSchema = v.pipe(v.number(), v.integer(), v.minValue(DICE_MIN_SIDES), v.maxValue(DICE_MAX_SIDES));

/** A poll's question, `plainTextSchema` at 1–80 chars (OME-1452). */
export const PollQuestionSchema = plainTextSchema(POLL_QUESTION_MAX_LENGTH);
/** One poll answer, `plainTextSchema` at 1–40 chars. */
export const PollOptionSchema = plainTextSchema(POLL_OPTION_MAX_LENGTH);
const PollOptionsSchema = v.pipe(v.array(PollOptionSchema), v.minLength(POLL_MIN_OPTIONS), v.maxLength(POLL_MAX_OPTIONS));
/** An index into the poll's options. Above the open poll's last option, the server answers `bad_message`. */
export const PollOptionIndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(POLL_MAX_OPTIONS - 1));
/** Votes per option, in option order. */
const PollCountsSchema = v.pipe(
  v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_ROOM_MEMBERS))),
  v.minLength(POLL_MIN_OPTIONS),
  v.maxLength(POLL_MAX_OPTIONS),
);
/** The room's open poll (ADR 0055): in `poll` and in the snapshot. `endsAt` is server time; `by` is the opener. */
const POLL_ENTRIES = {
  pollId: PollIdSchema,
  by: MemberIdSchema,
  question: PollQuestionSchema,
  options: PollOptionsSchema,
  counts: PollCountsSchema,
  endsAt: ServerTimeSchema,
};
export const PollSchema = v.pipe(
  v.object(POLL_ENTRIES),
  v.check((p) => p.counts.length === p.options.length, "one count per option"),
);
export type Poll = v.InferOutput<typeof PollSchema>;
/** The /conga line (OME-1574), in the snapshot for a late joiner: `ids` leader first, `last` the server time of the last join. */
export const CongaSchema = v.object({
  ids: v.pipe(
    v.array(MemberIdSchema),
    v.minLength(1),
    v.maxLength(CONGA_CAP),
    v.check((ids) => new Set(ids).size === ids.length, "duplicate member id"),
  ),
  last: ServerTimeSchema,
});
export type Conga = v.InferOutput<typeof CongaSchema>;
export { PollIdSchema, type PollId } from "./ids";

/**
 * Emote bubbles in the avatar motion atlas (`emote/<kind>`), plus per-avatar animations, not bubbles: `wave` (motion atlas)
 * `cheer` / `yawn` (expressions atlas, OME-1104) and `dance` (OME-1374). One `emote` message and one rate limit for all of them.
 */
export const EMOTE_KINDS = ["clap", "exclaim", "heart", "laugh", "question", "wave", "cheer", "yawn", "dance"] as const;
export const EmoteKindSchema = v.picklist(EMOTE_KINDS);
export type EmoteKind = v.InferOutput<typeof EmoteKindSchema>;

/** Timed reaction glyphs (OME-1625, ADR 0056), the Designer's set. Separate from emotes: they land on the video's timeline. */
export const REACTION_KINDS = ["heart", "laugh", "wow", "clap"] as const;
export const ReactionKindSchema = v.picklist(REACTION_KINDS);
export type ReactionKind = v.InferOutput<typeof ReactionKindSchema>;
/** One timed reaction: who, which glyph, and where in the current item the server's room clock was (`mediaMs`). */
export const ReactionSchema = v.object({ memberId: MemberIdSchema, kind: ReactionKindSchema, mediaMs: MediaMsSchema });
export type Reaction = v.InferOutput<typeof ReactionSchema>;
/** The dank-dungeon pair (OME-1671): one member bends over, the other thrusts behind them. */
export const PAIR_POSES = ["thrust", "bendover"] as const;
export const PairPoseSchema = v.picklist(PAIR_POSES);
export type PairPose = v.InferOutput<typeof PairPoseSchema>;

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
    /** Tokenless initial opt-in; legacy joins depart immediately on close (ADR 0043). */
    durableSession: v.optional(v.literal(true)),
    /** Resume authority; server identity overrides nickname/avatar and invite fields. */
    resumeToken: v.optional(ResumeTokenSchema),
    /** Shirt tint (ADR 0053); absent means 0. A resume keeps the member's own. */
    tint: v.optional(TintSchema),
    /** Avatar accessory (OME-1387); absent means 0. A resume keeps the member's own. */
    accessory: v.optional(AccessorySchema),
    /** Hair colour (OME-1435); absent means 0. A resume keeps the member's own. */
    hair: v.optional(HairSchema),
    /**
     * The room this member came from (OME-1556, ADR 0054). A door of this room back to it, with nobody on the cell in
     * front of it, is where they walk in; otherwise the default spot. Never stored or logged; a resume ignores it.
     */
    via: v.optional(RoomIdSchema),
    /** Opt in to relay `batch` frames (OME-1624, ADR 0050 amendment); absent or false gets one frame per message. */
    batch: v.optional(v.boolean()),
    /**
     * A fresh guest with no saved avatar (OME-2133): the room gives them the avatar the fewest members wear, ties at
     * random, instead of `avatar` (kept as the fallback). A resume ignores it.
     */
    avatarAuto: v.optional(v.literal(true)),
  }),
  v.strictObject({ type: v.literal("leave") }),
  /** Advisory visibility transition, never extends a disconnected hold. */
  v.strictObject({ type: v.literal("presence"), away: v.boolean() }),
  /** `seat: null` stands up. */
  v.strictObject({ type: v.literal("sit"), seat: v.nullable(SeatIndexSchema) }),
  /**
   * Stand on a floor cell (ADR 0053). Needs `join`. A cell under a solid piece, seats included (use `sit`), is
   * answered `error: bad_cell`. From a seat it stands up first (`seat-changed` null, then `walked`). Clients path
   * there themselves; send the destination only. Per member WALK_BURST / WALK_REFILL_MS, over it dropped silently.
   * `run` (absent: false) asks others to animate a jog; relayed in `walked` as sent, nothing else changes (OME-1461).
   * `teleport: true` (OME-1545) goes from the pad the member stands on to the other pad, `cell` (see `canTeleport`);
   * anything else is `error: bad_cell`. Relayed in `walked` as sent; same bucket.
   */
  v.strictObject({ type: v.literal("walk"), cell: FloorCellInputSchema, run: v.optional(v.boolean()), teleport: v.optional(v.boolean()) }),
  /** Needs `join`. Change shirt tint; relayed as `tint-changed` (setting the current tint is a no-op). Shares the `emote` bucket. */
  v.strictObject({ type: v.literal("set-tint"), tint: TintSchema }),
  /** Needs `join`. Change accessory; relayed as `accessory-changed` (setting the current one is a no-op). Shares the `emote` bucket. */
  v.strictObject({ type: v.literal("set-accessory"), accessory: AccessorySchema }),
  /** Needs `join`. Change hair colour; relayed as `hair-changed` (setting the current one is a no-op). Shares the `emote` bucket. */
  v.strictObject({ type: v.literal("set-hair"), hair: HairSchema }),
  /**
   * Needs `join`. Sit down on (or get up from) the floor of the member's `cell` (OME-1499); relayed as `floor-sat` on
   * change only. `on: true` without a `cell` (seated, or on the standing spot) is answered `error: bad_cell`. A walk,
   * a sit or a layout that moves them clears it (`floor-sat` false first). Shares the walk bucket: over it dropped silently.
   */
  v.strictObject({ type: v.literal("floor-sit"), on: v.boolean() }),
  /**
   * Needs `join`. Lie down on a layout piece whose kind has a `lie` style (OME-1773; the sofa, couch, lounger, cat and
   * bed), or get up with `piece: null` (back to the standing spot, like `sit` null). A piece without one is
   * `error: bad_cell`; one with a seat held by someone else, or someone else lying on it, is `error: seat_taken`. A
   * `sleep` piece (the bed, OME-2008) instead takes one sleeper per seat: the server gives the lowest side whose seat is
   * free (or the lier's own) and nobody sleeps on; none left is `seat_taken`. The lier first leaves their seat,
   * cell or floor sit (`seat-changed` null / `floor-sat` false), then `lay`; while they lie the piece's seats are taken.
   * Shares the walk bucket: over it dropped silently.
   */
  v.strictObject({ type: v.literal("lie"), piece: v.nullable(PieceIndexSchema) }),
  /**
   * Needs `join`. The member is (or stopped) typing a chat line; relayed as `typing-changed` on change only. Resend
   * `on: true` within TYPING_TIMEOUT_MS to stay on; the server clears it after that, on a chat line, a mute or a
   * disconnect. Per member TYPING_BURST / TYPING_REFILL_MS, over it dropped silently. Never in a snapshot.
   */
  v.strictObject({ type: v.literal("typing"), on: v.boolean() }),
  v.strictObject({ type: v.literal("chat"), text: ChatTextSchema }),
  /**
   * `/roll` (OME-1423, ADR 0054): needs `join`, answered `rolled` to everyone. Like `chat`: the chat bucket, `muted`
   * for a muted member, and it clears typing. The value is the server's, from the OS CSPRNG; never stored or logged.
   */
  v.strictObject({ type: v.literal("roll"), sides: DiceSidesSchema }),
  /**
   * Watch-party polls (OME-1452, ADR 0055), all need `join`. `poll-open` is a chat line (the chat bucket, `muted`);
   * with a poll already open it is `bad_message`. `vote` has its own bucket (VOTE_BURST, VOTE_REFILL_MS); a vote counts
   * once and replaces the member's earlier one, an option the poll lacks is `bad_message`. `poll-close` is for the opener
   * or the room's owner (`not_owner` otherwise). A `vote` or `poll-close` for a poll that is not open is dropped silently.
   */
  v.strictObject({ type: v.literal("poll-open"), question: PollQuestionSchema, options: PollOptionsSchema }),
  v.strictObject({ type: v.literal("vote"), pollId: PollIdSchema, option: PollOptionIndexSchema }),
  v.strictObject({ type: v.literal("poll-close"), pollId: PollIdSchema }),
  /** Clock sample; allowed before `join`. Answered with `pong` to the sender only. */
  v.strictObject({ type: v.literal("ping"), id: PingIdSchema }),
  /**
   * Desired room playback. Seek while playing = `{ playing: true, position }`.
   * Needs `join`; `url` must equal the current `embed.url`, synced or generic (ADR 0057 §1), else `error: no_embed`.
   * Capped at the generic cap, the larger of the two.
   * For a live embed (`playbackCaps(embed).live`) the server ignores `position`.
   */
  v.strictObject({
    type: v.literal("control"),
    url: v.pipe(v.string(), v.maxLength(MAX_GENERIC_EMBED_URL_LENGTH)),
    playing: v.boolean(),
    position: PositionSchema,
    /**
     * With `playing: true`, a shared 3-2-1 (OME-1625, ADR 0056): the server answers a `playback` whose `startAt` is
     * COUNTDOWN_MS after `at`. Ignored with `playing: false` and for a live embed. Absent means false.
     */
    countdown: v.optional(v.boolean()),
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
  /** Needs `join`. Rate-limited per member (EMOTE_BURST, EMOTE_REFILL_MS); never stored. */
  v.strictObject({ type: v.literal("emote"), kind: EmoteKindSchema }),
  /**
   * Needs `join`. A timed reaction (OME-1625, ADR 0056), relayed as `reacted` with the server's own `mediaMs`: the
   * client sends no time. Spends from the `emote` bucket; over it dropped silently, like a `walk`. Without a synced
   * current item (none, or generic) it is dropped silently.
   */
  v.strictObject({ type: v.literal("react"), kind: ReactionKindSchema }),
  /**
   * `/thrust` or `/bendover` (OME-1671). Needs `join` and a layout with `pairs: true`, else `error: pairs_off`. Shares the
   * `emote` bucket. If another member's open invite has the other pose, the two pair: the inviter stands up (`seat-changed`
   * null / `floor-sat` false), moves next to the sender (`walked`, `teleport: true`; the thruster behind the bender), then
   * `paired`; with no free cell for it, `error: bad_cell` and the invite stays. Otherwise this is the sender's invite
   * (`pair-invited`), replacing their own earlier one, open for PAIR_INVITE_TTL_MS. Never stored or in a snapshot.
   */
  v.strictObject({ type: v.literal("pair"), pose: PairPoseSchema }),
  /*
   * Owner moderation (ADR 0030). Each needs `join` with the owner token: the server checks joined,
   * then owner (`not_owner`), then the MODERATION_BURST bucket (`rate_limited`), then the target
   * (`bad_target`), and only then writes or broadcasts anything.
   */
  /** Remove another member: they're closed with CLOSE_CODES.KICKED, everyone else gets `member-left { reason: "kicked" }`. */
  v.strictObject({ type: v.literal("kick"), memberId: MemberIdSchema }),
  /** Mute or unmute another member's chat; broadcast as `member-muted`. Muted chat is answered `error: muted`. */
  v.strictObject({ type: v.literal("mute"), memberId: MemberIdSchema, muted: v.boolean() }),
  /** Who controls playback; broadcast as `control-policy-changed`. Setting the current policy is a no-op. */
  v.strictObject({ type: v.literal("control-policy"), policy: ControlPolicySchema }),
  /*
   * Playback queue (ADR 0031). Each needs `join` and passes the room's control policy like `control` does
   * (`control_owner_only` otherwise). A stale or unknown item id is ignored without an error: it's a race.
   */
  /**
   * Queue a raw page or embed URL. The server runs the share parser on it (`canonicalizeAnyEmbed`) and stores
   * only the result, else `unsupported_url`. Rate-limited per member and per room (`rate_limited`); `queue_full` at QUEUE_MAX.
   */
  v.strictObject({ type: v.literal("queue-add"), url: v.pipe(v.string(), v.maxLength(MAX_URL_LENGTH)) }),
  /** Drop an upcoming item. */
  v.strictObject({ type: v.literal("queue-remove"), itemId: QueueItemIdSchema }),
  /**
   * Move an upcoming item so it sits at `toIndex` afterwards (0 = plays next); past the end means last. Only upcoming
   * items move: the current item isn't in the queue, so naming it is ignored like any unknown id, as is a move to
   * where the item already is (no `queue-changed`). Rate-limited by the per-socket frame limit only, like `queue-remove`.
   */
  v.strictObject({ type: v.literal("queue-move"), itemId: QueueItemIdSchema, toIndex: QueueIndexSchema }),
  /** Manual next: applies only while `fromItemId` is the current item, so two clicks skip one item. The only way past live and generic items. */
  v.strictObject({ type: v.literal("queue-advance"), fromItemId: QueueItemIdSchema }),
  /**
   * The player reached the end of the current item (client rule in ADR 0031: not in an ad, the provider's video id
   * is the item's, not live). Not subject to the control policy. The first valid report advances the queue; the
   * server ignores reports for another item, a live or generic embed, an item current for under
   * QUEUE_ENDED_DEBOUNCE_MS, or a `position` more than QUEUE_ENDED_TOLERANCE_S from the room clock.
   */
  v.strictObject({ type: v.literal("ended"), itemId: QueueItemIdSchema, position: PositionSchema }),
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
  /** `layout-set`, `title-set`, `kick`, `mute` or `control-policy` from a member who didn't join with the owner token. */
  "not_owner",
  /** `chat` from a member the owner muted (ADR 0030). The text is dropped. */
  "muted",
  /** `control` from a non-owner while the room's control policy is `owner` (ADR 0030). */
  "control_owner_only",
  /** `kick` or `mute` naming no member of this room, or the sender themselves. */
  "bad_target",
  /** `queue-add` while the room already has QUEUE_MAX upcoming items. */
  "queue_full",
  /** `queue-add` with a URL the share parser refuses (not a synced provider, and not a valid generic embed or generic is off). */
  "unsupported_url",
  /** Unknown, expired, revoked or wrong-room resume credential; no fresh join fallback. */
  "resume_expired",
  /** `walk` to a cell under a solid piece or a seat (ADR 0053); `floor-sit` on while not standing on a cell (OME-1499); `pair` with no free cell beside the partner (OME-1671); `lie` on a piece with no lie style (OME-1773). */
  "bad_cell",
  /** `pair` in a room whose layout lacks `pairs: true` (OME-1671). */
  "pairs_off",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Why a member left: on their own (leave, close, timeout) or kicked by the owner (ADR 0030). */
export const MEMBER_LEFT_REASONS = ["left", "kicked"] as const;
export type MemberLeftReason = (typeof MEMBER_LEFT_REASONS)[number];

// Server → client. Unknown keys are stripped so the server can add fields.
const SingleServerMessageSchema = v.variant("type", [
  /**
   * First message after a successful join. `shareToken` authorizes this member's
   * `POST /rooms/:id/share` until they leave; it is never broadcast (absent from pre-M2 servers).
   */
  v.object({
    type: v.literal("snapshot"),
    self: MemberIdSchema,
    room: RoomStateSchema,
    shareToken: v.optional(ShareTokenSchema),
    /** Sender-only room-bound credential, never published to peers. */
    resumeToken: v.optional(ResumeTokenSchema),
    /** Absent means false for legacy servers. */
    resumed: v.optional(v.boolean()),
    /** True when this member joined with the room's owner token; only in their own snapshot (ADR 0028). */
    owner: v.optional(v.boolean()),
    /** The room's open poll (OME-1452). Absent when there is none, or from a server without polls. */
    poll: v.optional(PollSchema),
    /** The /conga line (OME-1574). Absent when nobody is in it, or from a server without it. */
    conga: v.optional(CongaSchema),
    /**
     * The current item's timed reactions (OME-1625), oldest first, at most REACTIONS_MAX (the latest). Cleared when
     * the item changes. Absent when there are none, or from a server without them.
     */
    reactions: v.optional(v.pipe(v.array(ReactionSchema), v.maxLength(REACTIONS_MAX))),
    /** Most members in the room at once since the current item started (OME-1625, for the recap). Absent with no item. */
    peakMembers: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_ROOM_MEMBERS))),
  }),
  v.object({ type: v.literal("member-joined"), member: MemberSchema }),
  /** `reason` is absent from a pre-M6 server: read it as `left`. */
  v.object({ type: v.literal("member-left"), memberId: MemberIdSchema, reason: v.optional(v.picklist(MEMBER_LEFT_REASONS)) }),
  v.object({ type: v.literal("seat-changed"), memberId: MemberIdSchema, seat: v.nullable(SeatIndexSchema) }),
  /**
   * A member's standing cell changed (ADR 0053): a `walk`, or a layout change that covered their cell (sent after
   * `layout-changed`: to DOOR_CELL, or null, their standing spot, when the door is covered too). Path there locally.
   */
  /** `run` and `teleport` as the `walk` sent them; absent (old clients, layout moves) means walking. */
  v.object({ type: v.literal("walked"), memberId: MemberIdSchema, cell: v.nullable(FloorCellSchema), run: v.optional(v.boolean()), teleport: v.optional(v.boolean()) }),
  /** A member changed shirt tint (ADR 0053). */
  v.object({ type: v.literal("tint-changed"), memberId: MemberIdSchema, tint: TintSchema }),
  /** A member changed accessory (OME-1387). */
  v.object({ type: v.literal("accessory-changed"), memberId: MemberIdSchema, accessory: AccessorySchema }),
  /** A member changed hair colour (OME-1435). */
  v.object({ type: v.literal("hair-changed"), memberId: MemberIdSchema, hair: HairSchema }),
  /** A member sat down on (or got up from) the floor (OME-1499). */
  v.object({ type: v.literal("floor-sat"), memberId: MemberIdSchema, on: v.boolean() }),
  /**
   * A member lay down on a layout piece, or got up (`piece: null`) (OME-1773). On change only; also sent `null` before a
   * sit, walk, floor sit, leave or a `layout-changed` that drops or moves the piece. The snapshot's `Member.lying`.
   * `sleeper`: their side on a `sleep` piece (OME-2008), the snapshot's `Member.sleeper`; absent otherwise and on `null`.
   */
  v.object({ type: v.literal("lay"), memberId: MemberIdSchema, piece: v.nullable(PieceIndexSchema), sleeper: v.optional(SleeperSchema) }),
  /** A member started or stopped typing (OME-1387). Ephemeral: a member missing from these is not typing. */
  v.object({ type: v.literal("typing-changed"), memberId: MemberIdSchema, on: v.boolean() }),
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
      /** The new current item's id (ADR 0031): every share and every advance gets one. Absent with a null embed, or from a pre-M6 server. */
      itemId: v.optional(QueueItemIdSchema),
    }),
    v.check((x) => playbackMatchesEmbed(x), "playback without an embed"),
    v.check((x) => x.itemId === undefined || x.embed !== null, "item id without an embed"),
  ),
  /**
   * The upcoming queue changed (ADR 0031): the whole list, in play order. `by` is who added or removed an item,
   * or advanced; null when an `ended` report advanced it. On an advance, `embed-changed` (with the new `itemId`) comes first.
   */
  v.object({ type: v.literal("queue-changed"), queue: QueueSchema, by: v.nullable(MemberIdSchema) }),
  /** A member's `catching` changed. Coalesced by the server; the latest value always arrives. */
  v.object({ type: v.literal("member-status"), memberId: MemberIdSchema, catching: v.boolean() }),
  v.object({ type: v.literal("member-presence"), memberId: MemberIdSchema, away: v.boolean() }),
  /** Reply to `ping`. `at` = server ms when it answered. */
  v.object({ type: v.literal("pong"), id: PingIdSchema, at: ServerTimeSchema }),
  /** The room's playback changed; published to every member. */
  v.object({ type: v.literal("playback"), playback: PlaybackStateSchema }),
  /** The owner replaced the layout. Seats keep their indices: draw seat `i` at the new `i`-th seat cell. */
  v.object({ type: v.literal("layout-changed"), layout: RoomLayoutSchema, by: MemberIdSchema }),
  /** The owner renamed the room. */
  v.object({ type: v.literal("title-changed"), title: RoomTitleSchema, by: MemberIdSchema }),
  /** A member emoted (sender included). Fire-and-forget: not stored, never in a snapshot, so late joiners don't see it. */
  v.object({ type: v.literal("emoted"), memberId: MemberIdSchema, kind: EmoteKindSchema }),
  /**
   * A member reacted (OME-1625, sender included). `mediaMs` is the server's room clock for the current item when it
   * arrived. Stored for the item (the snapshot's `reactions`), so late joiners can replay it.
   */
  v.object({ type: v.literal("reacted"), memberId: MemberIdSchema, kind: ReactionKindSchema, mediaMs: MediaMsSchema }),
  /** A member's open `pair` invite (OME-1671), sender included: "X wants to /thrust, to join in use /bendover". Fire-and-forget. */
  v.object({ type: v.literal("pair-invited"), memberId: MemberIdSchema, pose: PairPoseSchema }),
  /** Two members paired (OME-1671), after the inviter's `walked`. Clients play the poses; fire-and-forget, like `emoted`. */
  v.object({ type: v.literal("paired"), thrust: MemberIdSchema, bendover: MemberIdSchema }),
  /** A member rolled a `sides`-faced die and got `value`, 1..sides (sender included). Fire-and-forget, like `emoted`. */
  v.pipe(
    v.object({ type: v.literal("rolled"), memberId: MemberIdSchema, sides: DiceSidesSchema, value: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
    v.check((x) => x.value <= x.sides, "value above sides"),
  ),
  /** A poll opened, or its counts changed (a vote, a changed vote, a voter who left). The whole poll every time. */
  v.pipe(
    v.object({ type: v.literal("poll"), ...POLL_ENTRIES }),
    v.check((p) => p.counts.length === p.options.length, "one count per option"),
  ),
  /** The poll ended: its opener or the owner closed it, or POLL_DURATION_MS passed. `counts` are final. */
  v.object({ type: v.literal("poll-closed"), pollId: PollIdSchema, counts: PollCountsSchema }),
  /** The owner muted or unmuted a member's chat (ADR 0030); published to every member. */
  v.object({ type: v.literal("member-muted"), memberId: MemberIdSchema, muted: v.boolean() }),
  /** The owner changed who controls playback (ADR 0030). */
  v.object({ type: v.literal("control-policy-changed"), policy: ControlPolicySchema, by: MemberIdSchema }),
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

export const ServerMessageSchema = v.variant("type", [
  ...SingleServerMessageSchema.options,
  /**
   * Relays coalesced into one frame, in send order (OME-1624, ADR 0050 amendment). Only to a connection that joined
   * with `batch: true`; read it as its messages one by one. Never nested.
   */
  v.object({ type: v.literal("batch"), msgs: v.pipe(v.array(SingleServerMessageSchema), v.minLength(1), v.maxLength(BATCH_MAX_MESSAGES)) }),
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
