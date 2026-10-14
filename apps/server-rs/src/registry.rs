//! The live rooms (`rooms.ts` `RoomRegistry`) and everything the TS server keeps per room via `perRoom`.
//!
//! In TS the per-room maps live in the registry and `removeRoom` drops each one. Here a room's state is one
//! struct, [`RoomInner`], behind the room's mutex ([`RoomCell`]): dropping the cell drops all of it, so nothing
//! can be forgotten or resurrected by a late caller.
//!
//! Locking (PORTING.md): registry, then room, then store. The registry's lock is held only to look a cell up,
//! add one or unlink one; a handler already holding a room's lock never touches the registry. Removal hooks
//! (reports, sockets, store row) run in `App::remove_room`, after the registry lock is released.

use crate::contract::ids::{MemberId, RoomId, ShareToken};
use crate::outbox::Subscribers;
use crate::rate_limit::TokenBucket;
use crate::room::Room;
use crate::secrets::hash_secret;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

/// Why a room ends: owner delete, GC, operator delete; or an operator takedown (ADR 0033 section 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveReason {
    Closed,
    TakenDown,
}

/// `ROOM_CONTROL_BURST` / `ROOM_CONTROL_PER_SECOND` (ws-limits.ts): all `control`s of a room together.
pub const ROOM_CONTROL_BURST: f64 = 8.0;
pub const ROOM_CONTROL_PER_SECOND: f64 = 4.0;
/// `ROOM_SHARE_BURST` / `ROOM_SHARE_PER_SECOND` (http.ts): all shares into a room together.
pub const ROOM_SHARE_BURST: f64 = 2.0;
pub const ROOM_SHARE_PER_SECOND: f64 = 0.1;
/// `SHARE_BURST` / `SHARE_PER_SECOND` (http.ts): one member's shares.
pub const SHARE_BURST: f64 = 5.0;
pub const SHARE_PER_SECOND: f64 = 1.0 / 3.0;

/// What a joined member's share token authorizes in its room (`ShareGrant`, http.ts). Minted on join (S6),
/// revoked on leave. The member's `queue-add` bucket is [`RoomInner::member_add_bucket`], shared with its socket.
#[derive(Debug)]
pub struct ShareGrant {
    pub member_id: MemberId,
    /// Joined with the owner token: may share while the control policy is `owner` (ADR 0030 section 4).
    pub owner: bool,
    /// This member's shares.
    pub bucket: TokenBucket,
}

impl ShareGrant {
    pub fn new(member_id: MemberId, owner: bool, now_mono: f64) -> Self {
        Self {
            member_id,
            owner,
            bucket: TokenBucket::new(SHARE_BURST, SHARE_PER_SECOND, now_mono),
        }
    }
}

/// http.ts `verdicts`: the last title checked against the blocklist for this room (a rename can't skip the check).
#[derive(Debug, Default)]
pub struct TitleVerdict {
    pub title: Option<String>,
    pub blocked: bool,
}

/// Everything about one live room, behind its mutex. Fields are public: S5 and S6 mutate them under the lock.
///
/// **S6 adds here** (ws-sessions.ts:124, :126): `sessions` (members live or held, by id) and `resumable`
/// (durable members by resume token). They depend on S6's `Session` type, so they are added with it.
pub struct RoomInner {
    /// S4c's pure core.
    pub room: Room,
    /// Open sockets and topic subscribers (ws.ts `sockets`, Bun's topic).
    pub subscribers: Subscribers,
    /// Share grants by SHA-256 of the token: the secret newtypes have no `Hash`/`Eq`, and lookup stays constant-time-ish.
    pub grants: HashMap<[u8; 32], ShareGrant>,
    /// `roomControls` (ws.ts:116).
    pub control_bucket: TokenBucket,
    /// `roomAdds` (queue.ts:81).
    pub queue_add_bucket: TokenBucket,
    /// `roomShares` (http.ts:210).
    pub share_bucket: TokenBucket,
    /// `roomBuckets` (reports.ts:122).
    pub report_bucket: TokenBucket,
    /// `verdicts` (http.ts:213).
    pub title_verdict: TitleVerdict,
    /// Set (under this lock) when the room is unlinked from the registry: a handler that looked the cell up
    /// before then must refuse (a join closes with ROOM_CLOSED, a share answers 404).
    pub closed: bool,
    member_adds: HashMap<MemberId, TokenBucket>,
}

/// Counts only: a room's Debug must not print names, hashes, titles or embeds (ADR 0032, "name hashes only").
impl std::fmt::Debug for RoomInner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoomInner")
            .field("members", &self.room.member_count())
            .field("connections", &self.subscribers.len())
            .field("grants", &self.grants.len())
            .field("closed", &self.closed)
            .finish_non_exhaustive()
    }
}

impl RoomInner {
    pub fn new(room: Room, now_mono: f64) -> Self {
        Self {
            room,
            subscribers: Subscribers::default(),
            grants: HashMap::new(),
            control_bucket: TokenBucket::new(ROOM_CONTROL_BURST, ROOM_CONTROL_PER_SECOND, now_mono),
            queue_add_bucket: TokenBucket::new(
                f64::from(crate::contract::constants::QUEUE_ADD_ROOM_BURST),
                1000.0 / crate::contract::constants::QUEUE_ADD_ROOM_REFILL_MS as f64,
                now_mono,
            ),
            share_bucket: TokenBucket::new(ROOM_SHARE_BURST, ROOM_SHARE_PER_SECOND, now_mono),
            report_bucket: TokenBucket::new(
                f64::from(crate::contract::constants::REPORT_ROOM_BURST),
                1000.0 / crate::contract::constants::REPORT_ROOM_REFILL_MS as f64,
                now_mono,
            ),
            title_verdict: TitleVerdict::default(),
            closed: false,
            member_adds: HashMap::new(),
        }
    }

    /// The grant `token` holds in this room.
    pub fn grant(&self, _token: &ShareToken) -> Option<&ShareGrant> {
        None
    }

    pub fn grant_mut(&mut self, _token: &ShareToken) -> Option<&mut ShareGrant> {
        None
    }

    pub fn insert_grant(&mut self, _token: &ShareToken, _grant: ShareGrant) {}

    /// Revokes a grant (a member left). False if there was none.
    pub fn revoke_grant(&mut self, _token: &ShareToken) -> bool {
        false
    }

    /// The member's `queue-add` bucket, shared by their socket and `POST /rooms/:id/queue` (ADR 0031 section 2);
    /// created on first use. S6 drops it with `forget_member` when the member ends.
    pub fn member_add_bucket(&mut self, id: &MemberId, now_mono: f64) -> &mut TokenBucket {
        self.member_adds.entry(id.clone()).or_insert_with(|| {
            TokenBucket::new(
                f64::from(crate::contract::constants::QUEUE_ADD_MEMBER_BURST),
                1000.0 / crate::contract::constants::QUEUE_ADD_MEMBER_REFILL_MS as f64,
                now_mono,
            )
        })
    }

    /// The member ended: drops the state kept for them.
    pub fn forget_member(&mut self, _id: &MemberId) {}

    /// Entries in the per-room maps (sockets, grants, member buckets): what the TS suite's `perRoomSizes` counts.
    pub fn entries(&self) -> usize {
        0
    }

    pub fn id(&self) -> &RoomId {
        &self.room.id
    }

    /// The share grant map's key for `token`.
    fn key(token: &ShareToken) -> [u8; 32] {
        hash_secret(token.as_str())
    }
}

/// One registered room: its id and its locked state.
#[derive(Debug)]
pub struct RoomCell {
    pub id: RoomId,
    inner: Mutex<RoomInner>,
}

impl RoomCell {
    /// Locks the room. A poisoned lock (a handler panicked) is recovered, never unwrapped: the other rooms and
    /// this one's later messages must keep working.
    pub fn lock(&self) -> MutexGuard<'_, RoomInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `addRoom` of an id already registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateRoom;

#[derive(Debug, Default)]
struct Slots {
    /// Insertion order is observable (pinned rooms in seed order, GC order, the operator's list): a JS `Map`'s.
    cells: BTreeMap<u64, Arc<RoomCell>>,
    by_id: HashMap<RoomId, u64>,
    next: u64,
}

/// The live rooms, in insertion order.
#[derive(Debug, Default)]
pub struct Registry {
    slots: RwLock<Slots>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, _id: &RoomId) -> Option<Arc<RoomCell>> {
        None
    }

    /// `has(room)`: this very cell is the registered one (a re-created room of the same id is another cell).
    pub fn is_registered(&self, _cell: &Arc<RoomCell>) -> bool {
        false
    }

    pub fn len(&self) -> usize {
        0
    }

    pub fn is_empty(&self) -> bool {
        true
    }

    /// The rooms in insertion order, as of now.
    pub fn values(&self) -> Vec<Arc<RoomCell>> {
        Vec::new()
    }

    /// Registers a room; `Err` if its id is taken.
    pub fn add_room(&self, _room: Room, _now_mono: f64) -> Result<Arc<RoomCell>, DuplicateRoom> {
        Err(DuplicateRoom)
    }

    /// Unlinks a room: new lookups miss it and `closed` is set. `None` if it was not registered. Only the
    /// unlinking; `App::remove_room` runs the hooks.
    pub fn remove(&self, _id: &RoomId) -> Option<Arc<RoomCell>> {
        None
    }

    /// Like `remove`, but only if `keep_going` holds for the room, checked under the registry's write lock and
    /// the room's own, so nothing can change between the check and the unlink (GC uses it to skip a room
    /// someone just joined).
    pub fn remove_if(&self, _id: &RoomId, _keep_going: impl FnOnce(&RoomInner) -> bool) -> Option<Arc<RoomCell>> {
        None
    }

    /// Total [`RoomInner::entries`] over the live rooms.
    pub fn per_room_entries(&self) -> usize {
        0
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use crate::room::RoomInit;

    pub fn rid(id: &str) -> RoomId {
        RoomId::parse(id).unwrap()
    }

    pub fn room(id: &str) -> Room {
        Room::new(rid(id), RoomInit::default(), 0).unwrap()
    }

    pub fn inner() -> RoomInner {
        RoomInner::new(room("lobby"), 0.0)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::contract::ids::ShareToken;
    use crate::outbox::{ConnId, channel};

    fn ids(r: &Registry) -> Vec<String> {
        r.values().iter().map(|c| c.id.as_str().to_owned()).collect()
    }

    fn token(c: char) -> ShareToken {
        ShareToken::parse(&c.to_string().repeat(22)).unwrap()
    }

    // apps/server/src/rooms.ts: a Map, so insertion order
    #[test]
    fn rooms_iterate_in_insertion_order_even_after_removals_and_re_adds() {
        let r = Registry::new();
        for id in ["lobby", "b", "c", "d"] {
            r.add_room(room(id), 0.0).unwrap();
        }
        assert_eq!(ids(&r), ["lobby", "b", "c", "d"]);
        assert!(r.remove(&rid("b")).is_some());
        r.add_room(room("b"), 0.0).unwrap();
        assert_eq!(ids(&r), ["lobby", "c", "d", "b"]);
        assert_eq!(r.len(), 4);
        assert!(!r.is_empty());
    }

    // apps/server/src/rooms.ts:41 "throws if its id is taken"
    #[test]
    fn adding_a_taken_id_is_refused_and_changes_nothing() {
        let r = Registry::new();
        let first = r.add_room(room("lobby"), 0.0).unwrap();
        assert_eq!(r.add_room(room("lobby"), 0.0).unwrap_err(), DuplicateRoom);
        assert!(Arc::ptr_eq(&r.get(&rid("lobby")).unwrap(), &first));
        assert_eq!(r.len(), 1);
    }

    // apps/server/test/room-lifecycle.test.ts:55 (removeRoom is false the second time), :186 (never resurrected)
    #[test]
    fn removal_unlinks_once_marks_the_cell_closed_and_a_recreated_room_is_another_cell() {
        let r = Registry::new();
        let old = r.add_room(room("film-club"), 0.0).unwrap();
        assert!(r.is_registered(&old));
        let gone = r.remove(&rid("film-club")).unwrap();
        assert!(Arc::ptr_eq(&gone, &old));
        assert!(old.lock().closed);
        assert!(r.remove(&rid("film-club")).is_none());
        assert!(r.get(&rid("film-club")).is_none());
        assert!(!r.is_registered(&old));
        let fresh = r.add_room(room("film-club"), 0.0).unwrap();
        assert!(!fresh.lock().closed);
        assert!(!r.is_registered(&old), "the old cell stays unregistered");
        assert!(r.is_registered(&fresh));
    }

    #[test]
    fn remove_if_checks_under_the_locks_and_leaves_the_room_when_the_check_fails() {
        let r = Registry::new();
        let cell = r.add_room(room("a"), 0.0).unwrap();
        assert!(r.remove_if(&rid("a"), |_| false).is_none());
        assert!(r.get(&rid("a")).is_some());
        assert!(!cell.lock().closed);
        assert!(r.remove_if(&rid("zzz"), |_| true).is_none());
        assert!(r.remove_if(&rid("a"), |inner| inner.room.member_count() == 0).is_some());
        assert!(cell.lock().closed);
    }

    #[test]
    fn a_poisoned_room_lock_is_recovered_and_other_rooms_are_untouched() {
        let r = Registry::new();
        let cell = r.add_room(room("a"), 0.0).unwrap();
        let other = r.add_room(room("b"), 0.0).unwrap();
        let c2 = cell.clone();
        let panicked = std::thread::spawn(move || {
            let _held = c2.lock();
            panic!("a handler bug");
        })
        .join();
        assert!(panicked.is_err());
        assert_eq!(cell.lock().room.member_count(), 0, "still usable");
        assert_eq!(other.lock().room.member_count(), 0);
        assert!(r.remove(&rid("a")).is_some());
    }

    #[test]
    fn a_poisoned_registry_lock_is_recovered_too() {
        let r = Arc::new(Registry::new());
        r.add_room(room("a"), 0.0).unwrap();
        let r2 = r.clone();
        let panicked = std::thread::spawn(move || {
            let _held = r2.slots.write().unwrap();
            panic!("a bug under the registry lock");
        })
        .join();
        assert!(panicked.is_err());
        assert!(r.get(&rid("a")).is_some());
        r.add_room(room("b"), 0.0).unwrap();
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn grants_are_found_by_token_and_revoked_once() {
        let mut inner = inner();
        let (a, b) = (token('a'), token('b'));
        let member = MemberId::parse("m1").unwrap();
        inner.insert_grant(&a, ShareGrant::new(member.clone(), true, 0.0));
        assert_eq!(inner.grant(&a).unwrap().member_id, member);
        assert!(inner.grant(&a).unwrap().owner);
        assert!(inner.grant(&b).is_none());
        assert!(inner.grant_mut(&a).unwrap().bucket.take(0.0));
        assert!(inner.revoke_grant(&a));
        assert!(!inner.revoke_grant(&a));
        assert!(inner.grant(&a).is_none());
    }

    // apps/server/src/queue.ts:94 / ws.ts: the member's add bucket is one object for socket and HTTP
    #[test]
    fn a_member_has_one_add_bucket_until_forgotten() {
        let mut inner = inner();
        let m = MemberId::parse("m1").unwrap();
        for _ in 0..3 {
            assert!(inner.member_add_bucket(&m, 0.0).take(0.0));
        }
        assert!(!inner.member_add_bucket(&m, 0.0).take(0.0), "QUEUE_ADD_MEMBER_BURST is 3: same bucket");
        inner.forget_member(&m);
        assert!(inner.member_add_bucket(&m, 0.0).take(0.0), "a fresh one");
    }

    // apps/server/test/room-lifecycle.test.ts:132-195 perRoomSizes
    #[test]
    fn per_room_entries_count_sockets_grants_and_member_buckets_and_go_with_the_room() {
        let r = Registry::new();
        let cell = r.add_room(room("a"), 0.0).unwrap();
        assert_eq!(r.per_room_entries(), 0);
        {
            let mut inner = cell.lock();
            let (tx, _rx) = channel();
            inner.subscribers.attach(ConnId(1), tx);
            inner.insert_grant(&token('a'), ShareGrant::new(MemberId::parse("m1").unwrap(), false, 0.0));
            inner.member_add_bucket(&MemberId::parse("m1").unwrap(), 0.0);
            assert_eq!(inner.entries(), 3);
        }
        assert_eq!(r.per_room_entries(), 3);
        r.remove(&rid("a"));
        assert_eq!(r.per_room_entries(), 0);
    }

    #[test]
    fn the_per_room_state_starts_full_like_a_lazily_created_bucket() {
        let mut inner = inner();
        for _ in 0..8 {
            assert!(inner.control_bucket.take(0.0));
        }
        assert!(!inner.control_bucket.take(0.0));
        assert!(inner.share_bucket.take(0.0) && inner.share_bucket.take(0.0) && !inner.share_bucket.take(0.0));
        assert_eq!(inner.id().as_str(), "lobby");
    }
}
