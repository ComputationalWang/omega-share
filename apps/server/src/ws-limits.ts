import { EMOTE_BURST, EMOTE_REFILL_MS, MODERATION_BURST, MODERATION_REFILL_MS, ROOM_EDIT_BURST, ROOM_EDIT_REFILL_MS } from "@omega/shared";
import { TokenBucket, type Clock } from "./rate-limit";

// Rates are server-private (ADR 0016 §1); the numbers are the threat model's §6.
/** L1, per socket: bursts of 20 messages, 10/s sustained. Human pace; stops relay amplification. */
export const WS_BURST = 20;
export const WS_PER_SECOND = 10;
/** Per socket. */
const CHAT_BURST = 5;
export const CHAT_PER_SECOND = 1;
const SIT_BURST = 4;
const SIT_PER_SECOND = 1;
/** L2, per socket, `control` only: 4/s (docs/research/m1b-youtube-sync.md §6). */
export const CONTROL_BURST = 4;
const CONTROL_PER_SECOND = 4;
/** Per room, `control` from all its members together. */
export const ROOM_CONTROL_BURST = 8;
export const ROOM_CONTROL_PER_SECOND = 4;
/** Per client key: `join` attempts, and WebSocket upgrades (answered with HTTP 429). */
export const JOIN_BURST = 6;
export const JOIN_PER_SECOND = 0.2;
export const UPGRADE_BURST = 10;
export const UPGRADE_PER_SECOND = 0.5;
/**
 * Per client key: joins with a wrong owner token or a missing or wrong invite key (ADR 0028 §3, §4).
 * Tighter than the join limiter, so it binds: a real client never retries a wrong secret (tokens
 * don't rotate), it only sends what it stored.
 */
export const FAILED_OWNER_BURST = 5;
export const FAILED_OWNER_PER_SECOND = 1 / 30;
export const FAILED_INVITE_BURST = 5;
export const FAILED_INVITE_PER_SECOND = 1 / 30;
/** Escalation: close with CLOSE_CODES.RATE_LIMITED / BAD_MESSAGES. */
export const MAX_DROPPED_IN_A_ROW = 50;
export const MAX_BAD_MESSAGES = 20;
/** Bun closes a socket (1006) whose unsent data passes this, instead of buffering up to 16 MB. */
export const BACKPRESSURE_LIMIT = 256 * 1024;
export const IDLE_TIMEOUT_S = 60;
/** At most one `member-status` per member per this, trailing edge (ADR 0019 §3). */
export const STATUS_INTERVAL_MS = 1000;

/** Per-member limiters: kept with the member through leave and rejoin on one socket, and through a grace hold. */
export interface MemberBuckets {
  chat: TokenBucket;
  sit: TokenBucket;
  /** L2: `control` only, so seek wars stay bounded. */
  control: TokenBucket;
  /** Owner edits, `layout-set` and `title-set` together (ADR 0028 §6). */
  edit: TokenBucket;
  emote: TokenBucket;
  /** Owner moderation, `kick`, `mute` and `control-policy` together (ADR 0030 §1). */
  moderation: TokenBucket;
  /** `queue-add`, shared with `POST /rooms/:id/queue` through the share grant (ADR 0031 §2). */
  queue: TokenBucket;
}

/** A new socket's own buckets; `queue` is the playback queue's member bucket. */
export const newMemberBuckets = (queue: TokenBucket, now: Clock): MemberBuckets => ({
  chat: new TokenBucket(CHAT_BURST, CHAT_PER_SECOND, now),
  sit: new TokenBucket(SIT_BURST, SIT_PER_SECOND, now),
  control: new TokenBucket(CONTROL_BURST, CONTROL_PER_SECOND, now),
  edit: new TokenBucket(ROOM_EDIT_BURST, 1000 / ROOM_EDIT_REFILL_MS, now),
  emote: new TokenBucket(EMOTE_BURST, 1000 / EMOTE_REFILL_MS, now),
  moderation: new TokenBucket(MODERATION_BURST, 1000 / MODERATION_REFILL_MS, now),
  queue,
});
