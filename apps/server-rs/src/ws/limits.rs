//! ws-limits.ts: the per-socket and per-member rates. Server-private (ADR 0016 section 1); the numbers are the
//! threat model's section 6.

use crate::app::lock;
use crate::contract::constants::{
    EMOTE_BURST, EMOTE_REFILL_MS, MODERATION_BURST, MODERATION_REFILL_MS, ROOM_EDIT_BURST, ROOM_EDIT_REFILL_MS,
};
use crate::rate_limit::TokenBucket;
use std::sync::{Arc, Mutex, MutexGuard};

/// L1, per socket: bursts of 20 messages, 10/s sustained.
pub const WS_BURST: f64 = 20.0;
pub const WS_PER_SECOND: f64 = 10.0;
const CHAT_BURST: f64 = 5.0;
const CHAT_PER_SECOND: f64 = 1.0;
const SIT_BURST: f64 = 4.0;
const SIT_PER_SECOND: f64 = 1.0;
/// L2, per socket, `control` only: 4/s.
const CONTROL_BURST: f64 = 4.0;
const CONTROL_PER_SECOND: f64 = 4.0;
/// Per client key: `join` attempts, and WebSocket upgrades (answered with HTTP 429).
pub const JOIN_BURST: f64 = 6.0;
pub const JOIN_PER_SECOND: f64 = 0.2;
pub const UPGRADE_BURST: f64 = 10.0;
pub const UPGRADE_PER_SECOND: f64 = 0.5;
/// Per client key: joins with a wrong owner token or a missing or wrong invite key (ADR 0028 section 3, 4).
pub const FAILED_BURST: f64 = 5.0;
pub const FAILED_PER_SECOND: f64 = 1.0 / 30.0;
/// Escalation: close with RATE_LIMITED / BAD_MESSAGES.
pub const MAX_DROPPED_IN_A_ROW: u32 = 50;
pub const MAX_BAD_MESSAGES: u32 = 20;
/// A socket with nothing received for this long is dropped; the server pings at half of it (`idleTimeout`, `sendPings`).
pub const IDLE_TIMEOUT_MS: f64 = 60_000.0;

/// Per-member limiters: kept with the member through leave and rejoin on one socket, and through a grace hold.
/// (The queue's add bucket is `RoomInner::member_add_bucket`: it is shared with `POST /rooms/:id/queue`.)
#[derive(Debug)]
pub struct MemberBuckets {
    pub chat: TokenBucket,
    pub sit: TokenBucket,
    /// L2: `control` only, so seek wars stay bounded.
    pub control: TokenBucket,
    /// Owner edits, `layout-set` and `title-set` together (ADR 0028 section 6).
    pub edit: TokenBucket,
    pub emote: TokenBucket,
    /// Owner moderation, `kick`, `mute` and `control-policy` together (ADR 0030 section 1).
    pub moderation: TokenBucket,
}

impl MemberBuckets {
    /// `newMemberBuckets`.
    pub fn new(now: f64) -> Self {
        Self {
            chat: TokenBucket::new(CHAT_BURST, CHAT_PER_SECOND, now),
            sit: TokenBucket::new(SIT_BURST, SIT_PER_SECOND, now),
            control: TokenBucket::new(CONTROL_BURST, CONTROL_PER_SECOND, now),
            edit: TokenBucket::new(f64::from(ROOM_EDIT_BURST), 1000.0 / ROOM_EDIT_REFILL_MS as f64, now),
            emote: TokenBucket::new(f64::from(EMOTE_BURST), 1000.0 / EMOTE_REFILL_MS as f64, now),
            moderation: TokenBucket::new(f64::from(MODERATION_BURST), 1000.0 / MODERATION_REFILL_MS as f64, now),
        }
    }
}

/// Shared by a socket and its session, so a resume adopts the member's buckets instead of refilling them (ADR 0043).
/// Only ever locked under the room's lock, so it never contends.
#[derive(Debug, Clone)]
pub struct Buckets(Arc<Mutex<MemberBuckets>>);

impl Buckets {
    pub fn new(now: f64) -> Self {
        Self(Arc::new(Mutex::new(MemberBuckets::new(now))))
    }

    pub fn lock(&self) -> MutexGuard<'_, MemberBuckets> {
        lock(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(bucket: &mut TokenBucket, now: f64) -> u32 {
        let mut taken = 0;
        while bucket.take(now) {
            taken += 1;
        }
        taken
    }

    // apps/server/test/ws-limits.test.ts:10
    #[test]
    fn a_fresh_member_gets_the_threat_models_bursts_refilled_at_their_rates() {
        let b = Buckets::new(0.0);
        let mut g = b.lock();
        assert_eq!(drain(&mut g.chat, 0.0), 5);
        assert_eq!(drain(&mut g.sit, 0.0), 4);
        assert_eq!(drain(&mut g.control, 0.0), 4);
        assert_eq!(drain(&mut g.chat, 1000.0), 1);
        assert_eq!(drain(&mut g.sit, 1000.0), 1);
        assert_eq!(drain(&mut g.control, 1000.0), 4);
    }
}
