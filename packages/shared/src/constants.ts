/** Room everyone lands in until M2 adds more rooms. */
export const DEFAULT_ROOM_ID = "lobby";
export const SEAT_COUNT = 8;
/** The room floor is FLOOR_CELLS × FLOOR_CELLS iso cells. */
export const FLOOR_CELLS = 10;
/** Most pieces in a room layout (ADR 0021); a full layout is ~2 KB of a snapshot. */
export const MAX_FURNITURE = 32;
/** Most doors to other rooms in one layout (ADR 0054). */
export const MAX_DOORS = 2;
/** A `roll`'s die has DICE_MIN_SIDES..DICE_MAX_SIDES faces (OME-1423). */
export const DICE_MIN_SIDES = 2;
export const DICE_MAX_SIDES = 100;
export const AVATAR_COUNT = 4;
/** Shirt tints a member can pick (ADR 0053); tint 0 is the avatar's own colours. */
export const TINT_COUNT = 6;
/** Avatar accessories a member can pick (ADR 0053, OME-1387; 5..8 OME-1532); accessory 0 is none. */
export const ACCESSORY_COUNT = 9;
/** Hair colours a member can pick (ADR 0053, OME-1435); hair 0 is the avatar's own. */
export const HAIR_COUNT = 6;
/** The /conga line (OME-1564, OME-1574): at most this many people; a `/conga` over this long after the last join starts a new line. */
export const CONGA_CAP = 12;
export const CONGA_WINDOW_MS = 120_000;
/** A dank-dungeon `/thrust` or `/bendover` invite (OME-1671) waits this long for the other pose, then lapses silently. */
export const PAIR_INVITE_TTL_MS = 60_000;
/** People in one room; matches the load-test budget in docs/perf-budgets.md. */
export const MAX_ROOM_MEMBERS = 25;
/** Room ids are `[a-z0-9-]`, 1 to this many characters. */
export const ROOM_ID_MAX_LENGTH = 32;
/** Room titles: UTF-16 units, counted after NFKC normalisation (ADR 0028). */
export const ROOM_TITLE_MAX_LENGTH = 32;
/** UTF-16 units, counted after NFKC normalisation. */
export const NICKNAME_MAX_LENGTH = 20;
/** Most combining marks in a row in a nickname. */
export const NICKNAME_MAX_MARK_RUN = 2;
export const CHAT_MAX_LENGTH = 280;
/** Most combining marks in a row in chat text (stops Zalgo stacks). */
export const CHAT_MAX_MARK_RUN = 3;
/** Longest raw URL a share request may carry; the server canonicalizes it. */
export const MAX_URL_LENGTH = 2048;
/** Longest canonical Embed.url is ~70 chars (Vimeo id 12 + hash 32); 128 leaves room. */
export const MAX_EMBED_URL_LENGTH = 128;
/** Largest WebSocket frame the server accepts from a client, in UTF-8 bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;
/**
 * Largest frame a client accepts; must fit a worst-case full-room snapshot: ~6.8 KB with a full layout,
 * ~36 KB with QUEUE_MAX generic items at the longest url (ADR 0031).
 */
export const MAX_SERVER_MESSAGE_BYTES = 65536;
/** A relay `batch` frame (OME-1624) carries 1..BATCH_MAX_MESSAGES messages, and as a whole still fits MAX_SERVER_MESSAGE_BYTES. */
export const BATCH_MAX_MESSAGES = 64;
/** Most rooms `GET /rooms` returns; keeps the extension dropdown and body (~6 KB) small. */
export const MAX_LISTED_ROOMS = 100;
/** Largest `POST /rooms` body, in bytes; a real one is ~110 B (ADR 0028). */
export const MAX_CREATE_BODY_BYTES = 1024;

/*
 * Room creation, cap and owner edits (ADR 0028). Enforced by the server; shared so tests and
 * the site's copy agree with it. Clients learn about them only through `rate_limited`,
 * `too_many_rooms` and `ROOM_CLOSED`.
 */
/** Per client key: this many creations at once, then one every ROOM_CREATE_KEY_REFILL_MS. */
export const ROOM_CREATE_KEY_BURST = 2;
export const ROOM_CREATE_KEY_REFILL_MS = 10 * 60_000;
/** Max `retryAfterMs` on a `POST /rooms` 429: the key bucket's full refill, above the shared `RETRY_AFTER_MAX_MS`. */
export const ROOM_CREATE_RETRY_AFTER_MAX_MS = ROOM_CREATE_KEY_REFILL_MS;
/** Whole server: this many creations at once, then one every ROOM_CREATE_GLOBAL_REFILL_MS. */
export const ROOM_CREATE_GLOBAL_BURST = 10;
export const ROOM_CREATE_GLOBAL_REFILL_MS = 60_000;
/** Stored rooms, pinned ones included. At the cap the server refuses (`too_many_rooms`) and never evicts. */
export const MAX_ROOMS = 500;
/** Per owner socket, `layout-set` and `title-set` together: this many at once, then one every ROOM_EDIT_REFILL_MS. */
export const ROOM_EDIT_BURST = 2;
export const ROOM_EDIT_REFILL_MS = 2000;

/**
 * Per member, `emote` (wave included): this many at once, then one every EMOTE_REFILL_MS. Over it, the
 * server answers `rate_limited` with `retryAfterMs` and drops the emote; it counts against the per-socket frame limit too.
 */
export const EMOTE_BURST = 3;
export const EMOTE_REFILL_MS = 1000;

/**
 * Per member, `walk` (ADR 0053): this many at once, then one every WALK_REFILL_MS (4/s). Over it, the server drops
 * the walk silently: no error, no disconnect. It counts against the per-socket frame limit too.
 */
export const WALK_BURST = 8;
export const WALK_REFILL_MS = 250;

/**
 * Per member, `typing` (ADR 0053, OME-1387): this many at once, then one every TYPING_REFILL_MS (1/s). Over it, the
 * server drops the frame silently. A `typing {on: true}` not refreshed within TYPING_TIMEOUT_MS is cleared by the server.
 */
export const TYPING_BURST = 2;
export const TYPING_REFILL_MS = 1000;
export const TYPING_TIMEOUT_MS = 5000;

/**
 * Watch-party polls (OME-1452, ADR 0055): a question of 1–POLL_QUESTION_MAX_LENGTH chars, POLL_MIN_OPTIONS..POLL_MAX_OPTIONS
 * options of 1–POLL_OPTION_MAX_LENGTH chars each. One poll per room, open POLL_DURATION_MS unless closed first.
 */
export const POLL_QUESTION_MAX_LENGTH = 80;
export const POLL_OPTION_MAX_LENGTH = 40;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
export const POLL_DURATION_MS = 60_000;
/** Per member, `vote`: this many at once, then one every VOTE_REFILL_MS (2/s). Over it, `rate_limited`. */
export const VOTE_BURST = 2;
export const VOTE_REFILL_MS = 500;

/*
 * Owner moderation (ADR 0030). In memory only, keyed by room and client address (ADR 0028 §7):
 * a restart forgets them, and nothing about who was kicked or muted reaches the disk.
 */
/** After a kick, joins to that room from the kicked member's address are closed with KICKED for this long. */
export const KICK_COOLDOWN_MS = 10 * 60_000;
/** A muted member's address stays muted in that room this long after they leave, so a reconnect doesn't lift it. */
export const MUTE_MEMORY_MS = 10 * 60_000;
/** Per owner socket, `kick`, `mute` and `control-policy` together: this many at once, then one every MODERATION_REFILL_MS. */
export const MODERATION_BURST = 5;
export const MODERATION_REFILL_MS = 1000;

/*
 * Playback queue (ADR 0031). Enforced by the server; shared so tests and the site's copy agree with it.
 */
/** Upcoming items per room, the current one not counted. A `queue-add` past it is answered `queue_full`. */
export const QUEUE_MAX = 20;
/** Per member, `queue-add`: this many at once, then one every QUEUE_ADD_MEMBER_REFILL_MS. */
export const QUEUE_ADD_MEMBER_BURST = 3;
export const QUEUE_ADD_MEMBER_REFILL_MS = 10_000;
/** Per room, every member's `queue-add` together: this many at once, then one every QUEUE_ADD_ROOM_REFILL_MS. */
export const QUEUE_ADD_ROOM_BURST = 10;
export const QUEUE_ADD_ROOM_REFILL_MS = 3_000;
/** An `ended` for an item that became current less than this long ago is ignored (a broken embed can't skip the queue). */
export const QUEUE_ENDED_DEBOUNCE_MS = 3_000;
/** An `ended` is valid only if its `position` is within this many seconds of the room clock (rejects pre-seek and local-only seeks). */
export const QUEUE_ENDED_TOLERANCE_S = 5;

/** Cap on human-readable error messages sent over the wire. */
export const ERROR_MESSAGE_MAX_LENGTH = 200;
/** Longest seekable playback position we accept, in seconds (12 h). */
export const MAX_POSITION_S = 12 * 60 * 60;
/** Most timed reactions the snapshot carries for the current item (OME-1625, ADR 0056); the server keeps the latest. */
export const REACTIONS_MAX = 256;
/** A countdown `control` starts the room this long after the press (OME-1625, ADR 0056). */
export const COUNTDOWN_MS = 3_000;
/** A playback `startAt` is at most this long after its `at`. */
export const COUNTDOWN_MAX_MS = 5_000;
/** Shared playback rate range. Always 1 in M1b–M3; a range so a shared rate later doesn't break old clients. */
export const PLAYBACK_RATE_MIN = 0.25;
export const PLAYBACK_RATE_MAX = 2;
/** Largest clock-ping id; clients wrap to 0 after it. */
export const PING_ID_MAX = 2 ** 31 - 1;
/** Largest `retryAfterMs` the server sends with `rate_limited` (ADR 0016). */
export const RETRY_AFTER_MAX_MS = 60_000;
/** How long a client waits before reconnecting after `CLOSE_CODES.RATE_LIMITED`. */
export const RATE_LIMITED_RECONNECT_MS = 10_000;

/**
 * WebSocket close codes the app uses (ADR 0016). All are in the 4000–4999 private range.
 * A browser sees 1006 for everything the server can't close itself: oversize frames,
 * backpressure (Bun closes those) and refusals before the upgrade (HTTP 429/503).
 */
export const CLOSE_CODES = {
  /** Client-side: no snapshot within the handshake timeout. Reconnect with backoff. */
  HANDSHAKE_TIMEOUT: 4000,
  /** No `join` within the server's join timeout. Reconnect normally. */
  JOIN_TIMEOUT: 4001,
  /** Sent after `room-full`. Don't reconnect. */
  ROOM_FULL: 4002,
  /** Reserved: the server can't send it while Bun closes slow readers itself (1006). */
  SLOW_CONSUMER: 4003,
  /** Sustained flooding. Wait RATE_LIMITED_RECONNECT_MS, then reconnect. */
  RATE_LIMITED: 4029,
  /** Too many malformed frames. Reconnect at maximum backoff. */
  BAD_MESSAGES: 4400,
  /** The room was deleted by its owner or by GC (ADR 0028). Don't reconnect; say the room is closed. */
  ROOM_CLOSED: 4004,
  /** The owner kicked this member (ADR 0030), or a join came back within KICK_COOLDOWN_MS. Don't reconnect; say so. */
  KICKED: 4005,
  /** The operators took the room down after a report (ADR 0033). Don't reconnect; show the takedown notice. */
  TAKEN_DOWN: 4006,
  /** Another socket resumed this identity (ADR 0043). Stop automatic reconnects. */
  SESSION_REPLACED: 4007,
  /** Presence moved to the standalone browser (ADR 0046). Don't reconnect. */
  HANDED_OFF: 4008,
  /** Activity room: no valid `admit` in time, or a bad/used/expired/foreign ticket (ADR 0046). Get one fresh ticket, then stop. */
  ADMISSION_FAILED: 4401,
  /** Activity membership, session or grant revoked or expired (ADR 0046). Re-authorize; don't auto-reconnect. */
  SESSION_REVOKED: 4403,
} as const;
export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

/** Abuse reports, `POST /rooms/:id/report` (ADR 0033). */
/** Longest report note, in UTF-16 code units after trimming and normalizing. */
export const REPORT_NOTE_MAX_LENGTH = 300;
/** Cap on the raw `POST /rooms/:id/report` body; the largest valid body is under 1 KiB. */
export const MAX_REPORT_BODY_BYTES = 2048;
/** Per client key: this many reports at once, then one every REPORT_KEY_REFILL_MS. Also the longest `retryAfterMs`. */
export const REPORT_KEY_BURST = 3;
export const REPORT_KEY_REFILL_MS = 10 * 60_000;
/** Per reported room, across all reporters: this many at once, then one every REPORT_ROOM_REFILL_MS. */
export const REPORT_ROOM_BURST = 20;
export const REPORT_ROOM_REFILL_MS = 60_000;
/** Most open reports stored on the whole server; past it new reports get `unavailable` (503). */
export const REPORT_MAX_OPEN = 1000;
/** Every report row is deleted this long after it was received, whatever its state. */
export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60_000;
