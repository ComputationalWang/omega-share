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
} as const;
export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];
