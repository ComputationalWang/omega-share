/** Room everyone lands in until M2 adds more rooms. */
export const DEFAULT_ROOM_ID = "lobby";
export const SEAT_COUNT = 8;
/** The room floor is FLOOR_CELLS × FLOOR_CELLS iso cells. */
export const FLOOR_CELLS = 10;
/** Most pieces in a room layout (ADR 0021); a full layout is ~2 KB of a snapshot. */
export const MAX_FURNITURE = 32;
export const AVATAR_COUNT = 4;
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
/** Largest frame a client accepts; must fit a worst-case full-room snapshot (~4.7 KB, ~6.8 KB with a full layout). */
export const MAX_SERVER_MESSAGE_BYTES = 16384;
/** Most rooms `GET /rooms` returns; keeps the extension dropdown and body (~6 KB) small. */
export const MAX_LISTED_ROOMS = 100;
/** Largest `POST /rooms` body, in bytes; a real one is ~110 B (ADR 0028). */
export const MAX_CREATE_BODY_BYTES = 1024;

/*
 * Room creation, cap, GC and owner edits (ADR 0028). Enforced by the server; shared so tests and
 * the site's copy agree with it. Clients learn about them only through `rate_limited`,
 * `too_many_rooms` and `ROOM_CLOSED`.
 */
/** Per client key: this many creations at once, then one every ROOM_CREATE_KEY_REFILL_MS. */
export const ROOM_CREATE_KEY_BURST = 2;
export const ROOM_CREATE_KEY_REFILL_MS = 10 * 60_000;
/** Whole server: this many creations at once, then one every ROOM_CREATE_GLOBAL_REFILL_MS. */
export const ROOM_CREATE_GLOBAL_BURST = 10;
export const ROOM_CREATE_GLOBAL_REFILL_MS = 60_000;
/** Stored rooms, pinned ones included. At the cap the server refuses (`too_many_rooms`) and never evicts. */
export const MAX_ROOMS = 500;
/** A created room nobody ever joined is deleted this long after creation. */
export const ROOM_GC_NEVER_JOINED_MS = 60 * 60_000;
/** A created room is deleted after it has been empty this long. Pinned (seeded) rooms never are. */
export const ROOM_GC_EMPTY_MS = 14 * 24 * 60 * 60_000;
/** How often the GC sweep runs (and once at boot). */
export const ROOM_GC_SWEEP_MS = 60 * 60_000;
/** Per owner socket, `layout-set` and `title-set` together: this many at once, then one every ROOM_EDIT_REFILL_MS. */
export const ROOM_EDIT_BURST = 2;
export const ROOM_EDIT_REFILL_MS = 2000;

/**
 * Per member, `emote` (wave included): this many at once, then one every EMOTE_REFILL_MS. Over it, the
 * server answers `rate_limited` with `retryAfterMs` and drops the emote; it counts against the per-socket frame limit too.
 */
export const EMOTE_BURST = 3;
export const EMOTE_REFILL_MS = 1000;

/** Cap on human-readable error messages sent over the wire. */
export const ERROR_MESSAGE_MAX_LENGTH = 200;
/** Longest seekable playback position we accept, in seconds (12 h). */
export const MAX_POSITION_S = 12 * 60 * 60;
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
} as const;
export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];
