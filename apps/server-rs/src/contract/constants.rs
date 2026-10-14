//! Contract constants, mirroring `packages/shared/src/constants.ts` value for value (checked by the
//! `constants` corpus). Counts and lengths are `usize`, durations `u64` ms, close codes `u16`.

/// Room everyone lands in until M2 adds more rooms.
pub const DEFAULT_ROOM_ID: &str = "lobby";
pub const SEAT_COUNT: usize = 0;
/// The room floor is FLOOR_CELLS × FLOOR_CELLS iso cells.
pub const FLOOR_CELLS: usize = 0;
/// Most pieces in a room layout (ADR 0021).
pub const MAX_FURNITURE: usize = 0;
pub const AVATAR_COUNT: usize = 0;
/// People in one room; matches the load-test budget in docs/perf-budgets.md.
pub const MAX_ROOM_MEMBERS: usize = 0;
/// Room ids are `[a-z0-9-]`, 1 to this many characters.
pub const ROOM_ID_MAX_LENGTH: usize = 0;
/// Room titles: UTF-16 units, counted after NFKC normalisation (ADR 0028).
pub const ROOM_TITLE_MAX_LENGTH: usize = 0;
/// UTF-16 units, counted after NFKC normalisation.
pub const NICKNAME_MAX_LENGTH: usize = 0;
/// Most combining marks in a row in a nickname.
pub const NICKNAME_MAX_MARK_RUN: usize = 0;
pub const CHAT_MAX_LENGTH: usize = 0;
/// Most combining marks in a row in chat text (stops Zalgo stacks).
pub const CHAT_MAX_MARK_RUN: usize = 0;
/// Longest raw URL a share request may carry; the server canonicalizes it.
pub const MAX_URL_LENGTH: usize = 0;
/// Longest canonical synced `Embed.url` plus headroom.
pub const MAX_EMBED_URL_LENGTH: usize = 0;
/// Largest WebSocket frame the server accepts from a client, in UTF-8 bytes.
pub const MAX_CLIENT_MESSAGE_BYTES: usize = 0;
/// Largest frame a client accepts; must fit a worst-case full-room snapshot (ADR 0031).
pub const MAX_SERVER_MESSAGE_BYTES: usize = 0;
/// Most rooms `GET /rooms` returns.
pub const MAX_LISTED_ROOMS: usize = 0;
/// Largest `POST /rooms` body, in bytes (ADR 0028).
pub const MAX_CREATE_BODY_BYTES: usize = 0;

/// Per client key: this many creations at once, then one every ROOM_CREATE_KEY_REFILL_MS (ADR 0028).
pub const ROOM_CREATE_KEY_BURST: u32 = 0;
pub const ROOM_CREATE_KEY_REFILL_MS: u64 = 0;
/// Max `retryAfterMs` on a `POST /rooms` 429: the key bucket's full refill.
pub const ROOM_CREATE_RETRY_AFTER_MAX_MS: u64 = ROOM_CREATE_KEY_REFILL_MS;
/// Whole server: this many creations at once, then one every ROOM_CREATE_GLOBAL_REFILL_MS.
pub const ROOM_CREATE_GLOBAL_BURST: u32 = 0;
pub const ROOM_CREATE_GLOBAL_REFILL_MS: u64 = 0;
/// Stored rooms, pinned ones included. At the cap the server refuses (`too_many_rooms`) and never evicts.
pub const MAX_ROOMS: usize = 0;
/// Per owner socket, `layout-set` and `title-set` together.
pub const ROOM_EDIT_BURST: u32 = 0;
pub const ROOM_EDIT_REFILL_MS: u64 = 0;

/// Per member, `emote` (wave included).
pub const EMOTE_BURST: u32 = 0;
pub const EMOTE_REFILL_MS: u64 = 0;

/// After a kick, joins from the kicked member's address are closed with KICKED for this long (ADR 0030).
pub const KICK_COOLDOWN_MS: u64 = 0;
/// A muted member's address stays muted this long after they leave.
pub const MUTE_MEMORY_MS: u64 = 0;
/// Per owner socket, `kick`, `mute` and `control-policy` together.
pub const MODERATION_BURST: u32 = 0;
pub const MODERATION_REFILL_MS: u64 = 0;

/// Upcoming items per room, the current one not counted (ADR 0031).
pub const QUEUE_MAX: usize = 0;
/// Per member, `queue-add`.
pub const QUEUE_ADD_MEMBER_BURST: u32 = 0;
pub const QUEUE_ADD_MEMBER_REFILL_MS: u64 = 0;
/// Per room, every member's `queue-add` together.
pub const QUEUE_ADD_ROOM_BURST: u32 = 0;
pub const QUEUE_ADD_ROOM_REFILL_MS: u64 = 0;
/// An `ended` for an item that became current less than this long ago is ignored.
pub const QUEUE_ENDED_DEBOUNCE_MS: u64 = 0;
/// An `ended` is valid only if its `position` is within this many seconds of the room clock.
pub const QUEUE_ENDED_TOLERANCE_S: f64 = 0.0;

/// Cap on human-readable error messages sent over the wire.
pub const ERROR_MESSAGE_MAX_LENGTH: usize = 0;
/// Longest seekable playback position we accept, in seconds (12 h).
pub const MAX_POSITION_S: f64 = 0.0;
/// Shared playback rate range.
pub const PLAYBACK_RATE_MIN: f64 = 0.0;
pub const PLAYBACK_RATE_MAX: f64 = 0.0;
/// Largest clock-ping id; clients wrap to 0 after it.
pub const PING_ID_MAX: u32 = 0;
/// Largest `retryAfterMs` the server sends with `rate_limited` (ADR 0016).
pub const RETRY_AFTER_MAX_MS: u64 = 0;
/// How long a client waits before reconnecting after `RATE_LIMITED`.
pub const RATE_LIMITED_RECONNECT_MS: u64 = 0;

/// WebSocket close codes (ADR 0016), all in the private 4000–4999 range.
pub mod close {
    /// Client-side: no snapshot within the handshake timeout.
    pub const HANDSHAKE_TIMEOUT: u16 = 0;
    /// No `join` within the server's join timeout.
    pub const JOIN_TIMEOUT: u16 = 0;
    /// Sent after `room-full`. Don't reconnect.
    pub const ROOM_FULL: u16 = 0;
    /// Reserved for slow readers.
    pub const SLOW_CONSUMER: u16 = 0;
    /// Sustained flooding.
    pub const RATE_LIMITED: u16 = 0;
    /// Too many malformed frames.
    pub const BAD_MESSAGES: u16 = 0;
    /// The room was deleted by its owner or by GC (ADR 0028).
    pub const ROOM_CLOSED: u16 = 0;
    /// The owner kicked this member (ADR 0030).
    pub const KICKED: u16 = 0;
    /// The operators took the room down after a report (ADR 0033).
    pub const TAKEN_DOWN: u16 = 0;
    /// Another socket resumed this identity (ADR 0043).
    pub const SESSION_REPLACED: u16 = 0;
    /// Presence moved to the standalone browser (ADR 0046).
    pub const HANDED_OFF: u16 = 0;
    /// Activity room admission failed (ADR 0046).
    pub const ADMISSION_FAILED: u16 = 0;
    /// Activity membership, session or grant revoked or expired (ADR 0046).
    pub const SESSION_REVOKED: u16 = 0;
}

/// Longest report note, in UTF-16 code units after trimming and normalizing (ADR 0033).
pub const REPORT_NOTE_MAX_LENGTH: usize = 0;
/// Cap on the raw `POST /rooms/:id/report` body.
pub const MAX_REPORT_BODY_BYTES: usize = 0;
/// Per client key: this many reports at once, then one every REPORT_KEY_REFILL_MS.
pub const REPORT_KEY_BURST: u32 = 0;
pub const REPORT_KEY_REFILL_MS: u64 = 0;
/// Per reported room, across all reporters.
pub const REPORT_ROOM_BURST: u32 = 0;
pub const REPORT_ROOM_REFILL_MS: u64 = 0;
/// Most open reports stored on the whole server; past it new reports get `unavailable` (503).
pub const REPORT_MAX_OPEN: usize = 0;
/// Every report row is deleted this long after it was received.
pub const REPORT_RETENTION_MS: u64 = 0;
