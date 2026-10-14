//! The live rooms (`rooms.ts` `RoomRegistry`) and everything the TS server keeps per room via `perRoom`.
//!
//! In TS the per-room maps live in the registry and `removeRoom` drops each one. Here a room's state is one
//! struct, [`RoomInner`], behind the room's mutex ([`RoomCell`]): dropping the cell drops all of it, so nothing
//! can be forgotten or resurrected by a late caller.
//!
//! Locking (PORTING.md): registry, then room, then store. The registry's lock is held only to look a cell up,
//! add one or unlink one. **Never call the registry while holding a room lock** (not `get`, not `len`, not
//! `values`): `remove_if` holds the registry write lock and wants a room, std's RwLock lets that writer starve
//! later readers, so the two deadlock. `remove_if` only `try_lock`s a room; a busy room is "retry later".
//! Removal hooks (reports, sockets, store row) run in `App::remove_room`, after the registry lock is released.
//!
//! "Is this room still live?" has one answer: `RoomInner::closed`, set under the room's lock when the room is
//! unlinked. Handlers enter a room through `App::with_open_room`, which checks it; code that already holds a
//! guard checks `inner.closed` (the domain functions in `queue`, `reports` and `owner_edits` do).

use crate::contract::ids::{MemberId, RoomId, ShareToken};
use crate::outbox::{ConnId, Outbox, Subscribers};
use crate::rate_limit::TokenBucket;
use crate::room::Room;
use crate::secrets::hash_secret;
use crate::ws::session::Session;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard, TryLockError};

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
    /// The room's members, live or held (ws-sessions.ts `sessions`): S6's.
    pub sessions: HashMap<MemberId, Session>,
    /// Durable members by the SHA-256 of their resume token (ws-sessions.ts `resumable`): a token resumes only in
    /// its own room. S6's.
    pub resumable: HashMap<[u8; 32], MemberId>,
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
            sessions: HashMap::new(),
            resumable: HashMap::new(),
            member_adds: HashMap::new(),
        }
    }

    /// The grant `token` holds in this room.
    pub fn grant(&self, token: &ShareToken) -> Option<&ShareGrant> {
        self.grants.get(&Self::key(token))
    }

    pub fn grant_mut(&mut self, token: &ShareToken) -> Option<&mut ShareGrant> {
        self.grants.get_mut(&Self::key(token))
    }

    pub fn insert_grant(&mut self, token: &ShareToken, grant: ShareGrant) {
        self.grants.insert(Self::key(token), grant);
    }

    /// Revokes a grant (a member left). False if there was none.
    pub fn revoke_grant(&mut self, token: &ShareToken) -> bool {
        self.grants.remove(&Self::key(token)).is_some()
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

    /// Takes the member's `queue-add` bucket out, so a socket that leaves can carry it to its next join (ws.ts keeps it
    /// in the socket's own buckets). S6 addition.
    pub fn take_member_bucket(&mut self, id: &MemberId) -> Option<TokenBucket> {
        self.member_adds.remove(id)
    }

    /// Puts a bucket taken with `take_member_bucket` back under the member's new id.
    pub fn put_member_bucket(&mut self, id: &MemberId, bucket: TokenBucket) {
        self.member_adds.insert(id.clone(), bucket);
    }

    /// The member ended: drops the state kept for them.
    pub fn forget_member(&mut self, id: &MemberId) {
        self.member_adds.remove(id);
    }

    /// Every member ends with the room (ws.ts `sessions.endAll`, minus the sessions S6 adds): share grants are
    /// revoked and member state dropped. Sockets are closed by `outbox::close_all`.
    ///
    /// **S6 adds here**: end every session (`Session` teardown, resume tokens) and cancel the join and
    /// `member-status` timers, as ws.ts's `onRemove` hook does before closing the sockets.
    pub fn end_all(&mut self) {
        for (member, mut session) in self.sessions.drain() {
            session.cancel_hold();
            // The room is going: only its member count stays honest for whoever still holds the cell.
            self.room.leave(&member, 0);
        }
        self.resumable.clear();
        self.grants.clear();
        self.member_adds.clear();
    }

    /// Entries in the per-room maps (sockets, grants, member buckets): what the TS suite's `perRoomSizes` counts.
    pub fn entries(&self) -> usize {
        self.subscribers.len() + self.grants.len() + self.member_adds.len()
    }

    /// A socket opened on the room. `Err(Closed)` if the room was removed: an upgrade that raced the removal
    /// would otherwise keep a socket that never gets its close frame.
    pub fn attach_socket(&mut self, conn: ConnId, outbox: Outbox) -> Result<(), Closed> {
        if self.closed {
            return Err(Closed);
        }
        self.subscribers.attach(conn, outbox);
        Ok(())
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
    /// Locks the room. A poisoned lock means a handler panicked under it and may have left the room half
    /// updated: the room is taken offline (marked closed, sockets closed 1012 so clients reconnect) and never
    /// served again. Other rooms keep working.
    pub fn lock(&self) -> MutexGuard<'_, RoomInner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                self.inner.clear_poison();
                if !guard.closed {
                    guard.closed = true;
                    crate::outbox::close_all(&mut guard, crate::metrics::SERVICE_RESTART, "room reset");
                    crate::log::log_error(crate::log::LogEvent::RoomPoisoned, None);
                }
                guard
            }
        }
    }

    /// Like [`Self::lock`], but `None` once the room was removed. Handlers enter a room through
    /// `App::with_open_room`, which uses this.
    pub fn lock_open(&self) -> Option<MutexGuard<'_, RoomInner>> {
        let guard = self.lock();
        (!guard.closed).then_some(guard)
    }
}

/// The room was removed: it takes no more sockets, shares, queue changes or reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Closed;

/// `addRoom` of an id already registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateRoom;

enum Attempt {
    Removed(Arc<RoomCell>),
    Missing,
    NotDue,
    Busy,
}

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

    fn read(&self) -> RwLockReadGuard<'_, Slots> {
        self.slots.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self) -> RwLockWriteGuard<'_, Slots> {
        self.slots.write().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn get(&self, id: &RoomId) -> Option<Arc<RoomCell>> {
        let slots = self.read();
        slots.cells.get(slots.by_id.get(id)?).cloned()
    }

    pub fn len(&self) -> usize {
        self.read().cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.read().cells.is_empty()
    }

    /// The rooms in insertion order, as of now.
    pub fn values(&self) -> Vec<Arc<RoomCell>> {
        self.read().cells.values().cloned().collect()
    }

    /// Registers a room; `Err` if its id is taken.
    pub fn add_room(&self, room: Room, now_mono: f64) -> Result<Arc<RoomCell>, DuplicateRoom> {
        let mut slots = self.write();
        if slots.by_id.contains_key(&room.id) {
            return Err(DuplicateRoom);
        }
        let cell = Arc::new(RoomCell {
            id: room.id.clone(),
            inner: Mutex::new(RoomInner::new(room, now_mono)),
        });
        let seq = slots.next;
        slots.next = seq.saturating_add(1);
        slots.by_id.insert(cell.id.clone(), seq);
        slots.cells.insert(seq, cell.clone());
        Ok(cell)
    }

    /// Unlinks a room: new lookups miss it and `closed` is set. `None` if it was not registered. Only the
    /// unlinking; `App::remove_room` runs the hooks. A busy room is waited for, outside the registry lock.
    pub fn remove(&self, id: &RoomId) -> Option<Arc<RoomCell>> {
        loop {
            match self.try_remove(id, |_| true) {
                Attempt::Removed(cell) => return Some(cell),
                Attempt::Missing | Attempt::NotDue => return None,
                Attempt::Busy => {
                    // Wait for the holder with no registry lock held, then try again.
                    let cell = self.get(id)?;
                    drop(cell.lock());
                }
            }
        }
    }

    /// Like `remove`, but only if `due` holds for the room, checked under the registry's write lock and
    /// the room's own, so nothing can change between the check and the unlink (GC uses it to skip a room
    /// someone just joined).
    pub fn remove_if(&self, id: &RoomId, due: impl FnOnce(&RoomInner) -> bool) -> Option<Arc<RoomCell>> {
        match self.try_remove(id, due) {
            Attempt::Removed(cell) => Some(cell),
            Attempt::Missing | Attempt::NotDue | Attempt::Busy => None,
        }
    }

    fn try_remove(&self, id: &RoomId, due: impl FnOnce(&RoomInner) -> bool) -> Attempt {
        let mut slots = self.write();
        let Some(&seq) = slots.by_id.get(id) else {
            return Attempt::Missing;
        };
        let Some(cell) = slots.cells.get(&seq).cloned() else {
            return Attempt::Missing;
        };
        // Never block on a room under the registry write lock: a busy room is not due now.
        let mut inner = match cell.inner.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return Attempt::Busy,
        };
        if !due(&inner) {
            return Attempt::NotDue;
        }
        inner.closed = true;
        drop(inner);
        slots.by_id.remove(id);
        slots.cells.remove(&seq);
        Attempt::Removed(cell)
    }

    /// Total [`RoomInner::entries`] over the live rooms.
    pub fn per_room_entries(&self) -> usize {
        self.values().iter().map(|c| c.lock().entries()).sum()
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
    fn is_registered(r: &Registry, cell: &Arc<RoomCell>) -> bool {
        r.get(&cell.id).is_some_and(|c| Arc::ptr_eq(&c, cell))
    }

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
        assert!(is_registered(&r, &old));
        let gone = r.remove(&rid("film-club")).unwrap();
        assert!(Arc::ptr_eq(&gone, &old));
        assert!(old.lock().closed);
        assert!(r.remove(&rid("film-club")).is_none());
        assert!(r.get(&rid("film-club")).is_none());
        assert!(!is_registered(&r, &old));
        let fresh = r.add_room(room("film-club"), 0.0).unwrap();
        assert!(!fresh.lock().closed);
        assert!(!is_registered(&r, &old), "the old cell stays unregistered");
        assert!(is_registered(&r, &fresh));
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
    fn lock_open_refuses_a_removed_room_and_attach_socket_too() {
        let r = Registry::new();
        let cell = r.add_room(room("a"), 0.0).unwrap();
        assert!(cell.lock_open().is_some());
        let (tx, _rx) = channel();
        assert!(cell.lock().attach_socket(ConnId(1), tx).is_ok());
        r.remove(&rid("a")).unwrap();
        assert!(cell.lock_open().is_none(), "the fetched cell is closed");
        let (tx, mut rx) = channel();
        assert_eq!(cell.lock().attach_socket(ConnId(2), tx), Err(Closed));
        assert!(!cell.lock().subscribers.is_attached(ConnId(2)));
        assert!(rx.try_recv().is_none());
    }

    // The registry write lock is never held while waiting on a room: a busy room is "not due, retry later".
    #[test]
    fn remove_if_does_not_wait_for_a_busy_room() {
        let r = Arc::new(Registry::new());
        let cell = r.add_room(room("a"), 0.0).unwrap();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let c2 = cell.clone();
        let holder = std::thread::spawn(move || {
            let _g = c2.lock();
            held_tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(400));
        });
        held_rx.recv().unwrap();
        let started = std::time::Instant::now();
        assert!(r.remove_if(&rid("a"), |_| true).is_none());
        assert!(started.elapsed() < std::time::Duration::from_millis(200), "it waited");
        assert!(r.get(&rid("a")).is_some(), "still registered, so the next sweep retries");
        assert!(!cell.lock().closed);
        holder.join().unwrap();
        assert!(r.remove_if(&rid("a"), |_| true).is_some());
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
        assert!(
            !inner.member_add_bucket(&m, 0.0).take(0.0),
            "QUEUE_ADD_MEMBER_BURST is 3: same bucket"
        );
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

    // M2: a handler that panicked under the lock may have left the room half updated: it goes offline.
    #[test]
    fn a_poisoned_room_is_taken_offline_and_its_sockets_close_1012() {
        let r = Registry::new();
        let cell = r.add_room(room("lobby"), 0.0).unwrap();
        let (tx, mut rx) = channel();
        cell.lock().attach_socket(ConnId(1), tx).unwrap();
        let c = Arc::clone(&cell);
        let _ = std::thread::spawn(move || {
            let _guard = c.lock();
            panic!("handler bug");
        })
        .join();
        assert!(cell.lock_open().is_none(), "never served again");
        assert!(cell.lock().closed);
        assert!(matches!(rx.try_recv(), Some(crate::outbox::Outbound::Close(1012, _))));
        let (tx, _rx) = channel();
        assert!(cell.lock().attach_socket(ConnId(2), tx).is_err(), "no new sockets");
        let other = r.add_room(room("other"), 0.0).unwrap();
        assert!(other.lock_open().is_some(), "other rooms are untouched");
    }
}
