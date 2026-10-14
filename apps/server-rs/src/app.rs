//! The process's shared state (`startServer` in server.ts and index.ts's database open): one `Arc<App>` that
//! every HTTP handler, WebSocket task and timer holds. Rules in PORTING.md "Runtime architecture".
//!
//! ```text
//! lock order      registry -> room (RoomCell) -> store -> reports state
//! no .await       while any of those locks is held
//! poisoned locks  recovered (`lock`), never unwrapped
//! ```
//!
//! S5 (HTTP), S6 (WebSocket) and S7 (operator) add their own fields here (connection counters, limiters, the
//! admin socket) next to the ones below; nothing below needs to change for that.

use crate::clock::SharedClock;
use crate::config::{DbPath, ServerConfig};
use crate::contract::Invalid;
use crate::contract::confusables::nickname_key;
use crate::contract::constants::{DEFAULT_ROOM_ID, QUEUE_MAX, close};
use crate::contract::generic_embed::AnyEmbed;
use crate::contract::ids::{QueueItemId, RoomId};
use crate::contract::js_compat::is_js_whitespace;
use crate::contract::layout::default_layout;
use crate::contract::unicode_props::{is_punctuation, is_symbol};
use crate::embed_policy::EmbedPolicy;
use crate::headers::{Header, security_headers};
use crate::log::{LogEvent, log_error};
use crate::metrics::Metrics;
use crate::outbox::close_all;
use crate::registry::{DuplicateRoom, Registry, RemoveReason, RoomCell, RoomInner};
use crate::reports::ReportsState;
use crate::room::{HeldSeat, Room, RoomInit, SEAT_HOLD_MS};
use crate::secrets::EntropyError;
use crate::store::{NewRoom, SeatHold, Store, StoreError};
use icu_properties::CodePointMapData;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

/// Locks a mutex, recovering a poisoned one (a handler panicked): the data is plain state that is still valid.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Why the process cannot start. The binary prints it on stderr and exits 1.
#[derive(Debug)]
pub enum BootError {
    /// index.ts: the database could not be opened. Printed as `DB_PATH <path>: <message>`.
    Db {
        path: String,
        cause: StoreError,
    },
    /// Loading rooms, takedowns or seat holds failed, e.g. a corrupt `rooms` row (the message names the room).
    Store(StoreError),
    /// The embed policy's own hosts or denylist are not bare hostnames.
    Policy(Invalid),
    Entropy(EntropyError),
}

impl fmt::Display for BootError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db { path, cause } => write!(f, "DB_PATH {path}: {cause}"),
            Self::Store(e) => write!(f, "{e}"),
            Self::Policy(e) => write!(f, "{e}"),
            Self::Entropy(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for BootError {}

/// A message-only error, for log lines that are not a failure of something else.
#[derive(Debug)]
struct Note(String);

impl fmt::Display for Note {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Note {}

/// The `ROOM_TITLE_BLOCKLIST` check (server.ts `titleBlocker`): titles containing a term, case and lookalikes
/// folded and separators dropped, can't be created or listed.
#[derive(Debug, Default)]
pub struct TitleBlocker {
    keys: Vec<String>,
}

/// `blockKey`: `nicknameKey` with whitespace, punctuation and symbols removed (`bad word` and `b.a.d-w_o r d` match `badword`).
pub fn block_key(text: &str) -> String {
    nickname_key(text)
        .chars()
        .filter(|&c| !(is_separator(c) || is_punctuation(c) || is_symbol(c) || is_js_whitespace(c)))
        .collect()
}

/// `\p{Z}`
fn is_separator(c: char) -> bool {
    GeneralCategoryGroup::Separator.contains(CodePointMapData::<GeneralCategory>::new().get(c))
}

impl TitleBlocker {
    pub fn new(terms: &[String]) -> Self {
        Self {
            keys: terms.iter().map(|t| block_key(t)).filter(|k| !k.is_empty()).collect(),
        }
    }

    /// True if `title` contains a blocked term. The empty title (an unset one) is never blocked.
    pub fn blocked(&self, title: &str) -> bool {
        if title.is_empty() || self.keys.is_empty() {
            return false;
        }
        let key = block_key(title);
        self.keys.iter().any(|k| key.contains(k.as_str()))
    }
}

/// Hook stages of `App::remove_room`, in the order they run (server.ts / reports.ts / ws.ts `onRemove`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hook {
    /// The report duplicate marks of the room are dropped.
    Reports,
    /// Every socket gets a close frame and every share grant is revoked.
    Sockets,
    /// The room's row is deleted.
    Store,
}

pub struct App {
    pub config: ServerConfig,
    pub clock: SharedClock,
    pub embeds: EmbedPolicy,
    /// Security headers for every response (`securityHeaders`).
    pub headers: &'static [Header],
    pub metrics: Metrics,
    pub registry: Registry,
    pub reports: ReportsState,
    pub title_blocker: TitleBlocker,
    store: Mutex<Store>,
}

impl App {
    /// Wires the app around an open `store` without loading any room: `boot` does that. Tests use it directly.
    pub fn new(config: ServerConfig, clock: SharedClock, store: Store) -> Result<Self, BootError> {
        let embeds =
            EmbedPolicy::new(config.generic_embeds, &config.own_hosts, &config.generic_embed_denylist).map_err(BootError::Policy)?;
        let taken_down = store.reports().takedowns().map_err(BootError::Store)?;
        Ok(Self {
            headers: security_headers(config.generic_embeds),
            metrics: Metrics::new(),
            registry: Registry::new(),
            reports: ReportsState::new(taken_down),
            title_blocker: TitleBlocker::new(&config.room_title_blocklist),
            store: Mutex::new(store),
            embeds,
            clock,
            config,
        })
    }

    /// `startServer` as index.ts runs it: opens the database `config.db_path` names, takes the seat holds the last
    /// process saved (once, so a crash loop can't replay them), loads the rooms (stored ones, then the lobby if the
    /// store lacks it) and applies the holds. A corrupt room row fails with a message naming the room.
    pub fn boot(config: ServerConfig, clock: SharedClock) -> Result<Arc<Self>, BootError> {
        let lobby = RoomId::parse(DEFAULT_ROOM_ID).ok_or_else(|| BootError::Policy(Invalid::new("default room id")))?;
        Self::boot_with(config, clock, &[lobby])
    }

    /// `boot` with the configured seed rooms (TS `rooms` option; `boot` passes just the lobby): created pinned and
    /// public if the store lacks them, in this order after the stored ones.
    pub fn boot_with(config: ServerConfig, clock: SharedClock, seeds: &[RoomId]) -> Result<Arc<Self>, BootError> {
        let path = match &config.db_path {
            DbPath::Memory => ":memory:".to_owned(),
            DbPath::File(p) => p.to_string_lossy().into_owned(),
        };
        let store = Store::open(&path).map_err(|cause| BootError::Db { path, cause })?;
        // Taken once, so a crash loop can't replay them (ADR 0032).
        let holds = store.rooms().take_seat_holds().unwrap_or_else(|err| {
            log_error(LogEvent::StoreSeatHolds, Some(&err));
            Vec::new()
        });
        let app = Self::new(config, clock, store)?;
        app.load_rooms(seeds)?;
        app.apply_seat_holds(&holds);
        Ok(Arc::new(app))
    }

    /// `loadRooms` (server.ts): every stored room, then the configured ones the store lacks. A stored embed the
    /// policy no longer accepts (GENERIC_EMBEDS off, a newly denied host) comes back as none; the row keeps it, so
    /// switching back restores it. Queue items get the same treatment. A restored current item counts as current
    /// from now (monotonic), so `ended` waits out the debounce again (ADR 0031 section 4).
    fn load_rooms(&self, configured: &[RoomId]) -> Result<(), BootError> {
        let (now, since) = (self.wall(), self.mono());
        let stored = self.store().rooms().list_rooms().map_err(BootError::Store)?;
        for r in stored {
            // A taken-down room's row that a failed delete left behind (ADR 0033 section 5): never served again.
            if self.reports.is_taken_down(&r.id) {
                let deleted = self.store().rooms().delete_room(&r.id);
                if let Err(err) = deleted {
                    log_error(LogEvent::StoreDeleteRoom, Some(&err));
                }
                continue;
            }
            let embed = r.embed.as_ref().and_then(|e| self.embeds.restore(e));
            // Items the policy no longer accepts are left out; their rows stay, as for the embed.
            let mut restored: Vec<(QueueItemId, AnyEmbed)> = r
                .queue
                .iter()
                .filter(|i| r.item_id.as_ref() != Some(&i.id))
                .filter_map(|i| Some((i.id.clone(), self.embeds.restore(&i.embed)?)))
                .collect();
            // Hidden rows don't count toward QUEUE_MAX while hidden, so a flip back can bring more: keep the oldest.
            // The rest are deleted, or they would stay ahead of later adds and come back in their place.
            if restored.len() > QUEUE_MAX {
                let cut = restored.split_off(QUEUE_MAX);
                log_error(
                    LogEvent::StoreQueue,
                    Some(&Note(format!("restored queue over QUEUE_MAX: {} items deleted", cut.len()))),
                );
                for (item, _) in &cut {
                    self.store().rooms().remove_queue_item(&r.id, item).map_err(BootError::Store)?;
                }
            }
            let init = RoomInit {
                layout: Some(r.layout),
                item_id: if embed.is_some() { r.item_id } else { None },
                embed,
                title: r.title,
                visibility: Some(r.visibility),
                pinned: Some(r.pinned),
                created_at: Some(r.created_at),
                owner_hash: r.owner_hash,
                invite_hash: r.invite_hash,
                last_active_at: r.last_active_at,
                control_policy: Some(r.control_policy),
                queue: restored,
                item_since: Some(since),
            };
            self.add_loaded(Room::new(r.id, init, now).map_err(BootError::Entropy)?)?;
        }
        for id in configured {
            // A taken-down seed isn't seeded again.
            if self.registry.get(id).is_some() || self.reports.is_taken_down(id) {
                continue;
            }
            let seed = NewRoom::seed(id.clone(), None, now, default_layout());
            self.store().rooms().create_room(&seed).map_err(BootError::Store)?;
            let init = RoomInit {
                created_at: Some(now),
                ..RoomInit::default()
            };
            self.add_loaded(Room::new(id.clone(), init, now).map_err(BootError::Entropy)?)?;
        }
        Ok(())
    }

    fn add_loaded(&self, room: Room) -> Result<(), BootError> {
        self.registry
            .add_room(room, self.mono())
            .map(drop)
            .map_err(|_| BootError::Store(StoreError::Invalid("room id")))
    }

    /// The seats the last process held, kept `SEAT_HOLD_MS` for their names (ADR 0032).
    fn apply_seat_holds(&self, holds: &[SeatHold]) {
        for cell in self.registry.values() {
            let held: Vec<HeldSeat> = holds
                .iter()
                .filter(|h| h.room_id == cell.id)
                .map(|h| HeldSeat {
                    name_hash: h.name_hash,
                    seat: h.seat,
                })
                .collect();
            if !held.is_empty() {
                cell.lock().room.hold_seats(&held, self.wall().saturating_add(SEAT_HOLD_MS));
            }
        }
    }

    /// The seats every room holds, for a graceful restart to save (`drain` in server.ts): registry order, then
    /// seat order.
    pub fn seat_holds(&self) -> Vec<SeatHold> {
        let mut holds = Vec::new();
        for cell in self.registry.values() {
            for h in cell.lock().room.held_seats() {
                holds.push(SeatHold {
                    room_id: cell.id.clone(),
                    name_hash: h.name_hash,
                    seat: h.seat,
                });
            }
        }
        holds
    }

    /// Monotonic ms (`now`): limiters, the `ended` debounce.
    pub fn mono(&self) -> f64 {
        self.clock.mono_ms()
    }

    /// Unix ms (`wallNow`).
    pub fn wall(&self) -> i64 {
        self.clock.wall_ms()
    }

    /// The one database connection (rooms and reports share it, as in index.ts). Keep the guard short.
    pub fn store(&self) -> MutexGuard<'_, Store> {
        lock(&self.store)
    }

    /// Room GC's clock (server.ts `markActive`): memory first, so a failed write can only make GC late.
    /// Logs `store.last_active` on failure.
    pub fn mark_active(&self, inner: &mut RoomInner, at: i64) {
        inner.room.last_active_at = Some(at);
        let result = self.store().rooms().set_last_active(&inner.room.id, at);
        if let Err(err) = result {
            log_error(LogEvent::StoreLastActive, Some(&err));
        }
    }

    pub fn title_blocked(&self, title: &str) -> bool {
        self.title_blocker.blocked(title)
    }

    /// Ends a room, once: unlinks it (new lookups miss it), then runs the hooks in the TS registration order:
    /// reports, sockets (every outbox gets ROOM_CLOSED, or TAKEN_DOWN for a takedown; grants are revoked), the
    /// store row. False if the room was not registered. Never call it with a room lock held.
    pub fn remove_room(&self, id: &RoomId, reason: RemoveReason) -> bool {
        let Some(cell) = self.registry.remove(id) else {
            return false;
        };
        self.end_room(&cell, reason, |_| {});
        true
    }

    /// THE way a handler enters a room: looks the cell up, takes its lock and runs `f` on the locked state.
    /// `None` if the room does not exist or was removed (a join closes ROOM_CLOSED, a share answers 404).
    /// `f` is synchronous: no `.await`, and it must not call the registry (it holds a room lock).
    pub fn with_open_room<R>(&self, id: &RoomId, f: impl FnOnce(&mut RoomInner) -> R) -> Option<R> {
        let cell = self.registry.get(id)?;
        let mut inner = cell.lock_open()?;
        Some(f(&mut inner))
    }

    /// Registers a new room (`POST /rooms`: create the row first, then this). `Err` if the id is taken.
    pub fn insert_room(&self, room: Room) -> Result<Arc<RoomCell>, DuplicateRoom> {
        self.registry.add_room(room, self.mono())
    }

    /// `closeAll` (ws.ts): a close frame to every socket of every room, counted in the close metrics.
    /// The graceful restart uses it with SERVICE_RESTART. Returns how many were queued.
    pub fn close_all_sockets(&self, code: u16, reason: &'static str) -> usize {
        let mut sent = 0;
        for cell in self.registry.values() {
            let queued = close_all(&mut cell.lock(), code, reason);
            for _ in 0..queued {
                self.metrics.count_close(code);
            }
            sent += queued;
        }
        sent
    }

    /// The hooks of a room already unlinked from the registry (`remove_room`, and GC after `remove_if`).
    pub(crate) fn end_room(&self, cell: &Arc<RoomCell>, reason: RemoveReason, mut seen: impl FnMut(Hook)) {
        seen(Hook::Reports);
        self.reports.drop_room(&cell.id);

        seen(Hook::Sockets);
        let (code, why) = match reason {
            RemoveReason::Closed => (close::ROOM_CLOSED, "room closed"),
            RemoveReason::TakenDown => (close::TAKEN_DOWN, "room taken down"),
        };
        {
            let mut inner = cell.lock();
            for _ in 0..close_all(&mut inner, code, why) {
                self.metrics.count_close(code);
            }
            inner.end_all();
        }

        seen(Hook::Store);
        // The room is gone from memory; a row that survives comes back at the next boot, where GC or the operator can end it.
        let deleted = self.store().rooms().delete_room(&cell.id);
        if let Err(err) = deleted {
            log_error(LogEvent::StoreDeleteRoom, Some(&err));
        }
    }

    /// Where the database is, for the binary's messages.
    pub fn db_label(config: &ServerConfig) -> String {
        match &config.db_path {
            DbPath::Memory => ":memory:".to_owned(),
            DbPath::File(p) => p.display().to_string(),
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use crate::clock::{Clock, Sleep};
    use crate::config::{Env, parse_config};
    use crate::contract::layout::default_layout;
    use crate::room::{Room, RoomInit};
    use crate::store::NewRoom;
    use std::path::Path;
    use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
    use std::time::Duration;

    /// A settable clock; `sleep` is tokio's, so `#[tokio::test(start_paused = true)]` drives it.
    pub struct ManualClock {
        mono: AtomicU64,
        wall: AtomicI64,
    }

    impl ManualClock {
        pub fn set_mono(&self, ms: f64) {
            self.mono.store(ms.to_bits(), Ordering::SeqCst);
        }
        pub fn set_wall(&self, ms: i64) {
            self.wall.store(ms, Ordering::SeqCst);
        }
    }

    impl Clock for ManualClock {
        fn mono_ms(&self) -> f64 {
            f64::from_bits(self.mono.load(Ordering::SeqCst))
        }
        fn wall_ms(&self) -> i64 {
            self.wall.load(Ordering::SeqCst)
        }
        fn sleep(&self, ms: f64) -> Sleep {
            Box::pin(tokio::time::sleep(Duration::from_millis(ms as u64)))
        }
    }

    pub const T0: i64 = 1_790_000_000_000;

    pub fn clock() -> Arc<ManualClock> {
        Arc::new(ManualClock {
            mono: AtomicU64::new(1000.0_f64.to_bits()),
            wall: AtomicI64::new(T0),
        })
    }

    pub fn env(pairs: &[(&str, &str)]) -> Env {
        let mut env = Env::new();
        env.insert("DB_PATH".to_owned(), ":memory:".to_owned());
        for (k, v) in pairs {
            env.insert((*k).to_owned(), (*v).to_owned());
        }
        env
    }

    pub fn config(pairs: &[(&str, &str)]) -> ServerConfig {
        parse_config(&env(pairs), Path::new("/")).unwrap()
    }

    /// An app over a private in-memory database, no rooms loaded.
    pub fn app_with(config: ServerConfig) -> (Arc<App>, Arc<ManualClock>) {
        let clock = clock();
        let app = App::new(config, clock.clone(), Store::open(":memory:").unwrap()).unwrap();
        (Arc::new(app), clock)
    }

    pub fn app() -> (Arc<App>, Arc<ManualClock>) {
        app_with(config(&[]))
    }

    pub fn rid(id: &str) -> RoomId {
        RoomId::parse(id).unwrap()
    }

    /// A registered room that is also a row in the store (an unpinned, ownerless one unless `init` says otherwise).
    pub fn add_room(app: &App, id: &str, init: RoomInit) -> Arc<RoomCell> {
        let room = Room::new(rid(id), init, T0).unwrap();
        app.store()
            .rooms()
            .create_room(&NewRoom::seed(rid(id), None, T0, default_layout()))
            .unwrap();
        app.registry.add_room(room, app.mono()).unwrap()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::outbox::{ConnId, Outbound, channel};
    use crate::room::RoomInit;

    fn blocker(terms: &[&str]) -> TitleBlocker {
        TitleBlocker::new(&terms.iter().map(|t| (*t).to_owned()).collect::<Vec<_>>())
    }

    // apps/server/src/server.ts:115 (titleBlocker), apps/server/test/room-create.test.ts ROOM_TITLE_BLOCKLIST
    #[test]
    fn the_title_blocker_folds_case_lookalikes_and_separators() {
        let b = blocker(&["badword"]);
        for title in [
            "badword",
            "BADWORD",
            "BADW0RD",
            "bad word",
            "b.a.d-w_o r d",
            "a badword here",
            "bаdword",
        ] {
            assert!(b.blocked(title), "{title}");
        }
        for title in ["", "good title", "bad", "word"] {
            assert!(!b.blocked(title), "{title}");
        }
    }

    #[test]
    fn terms_that_fold_to_nothing_block_nothing_and_no_terms_block_nothing() {
        assert!(!blocker(&[]).blocked("anything"));
        assert!(!blocker(&["...", " "]).blocked("anything"));
        assert!(blocker(&["...", "x y"]).blocked("a XY b"));
    }

    #[test]
    fn block_key_drops_whitespace_punctuation_and_symbols_but_keeps_letters_and_digits() {
        assert_eq!(block_key("a b.c-d_e!f$g\u{a0}h\u{2003}i\u{feff}j"), "abcdefghij");
        assert_eq!(block_key("BADW0RD"), block_key("badword"));
    }

    // apps/server/src/server.ts:253 markActive
    #[test]
    fn mark_active_sets_memory_and_the_stored_time() {
        let (app, _) = app();
        let cell = add_room(&app, "film-club", RoomInit::default());
        let mut inner = cell.lock();
        app.mark_active(&mut inner, T0 + 5);
        assert_eq!(inner.room.last_active_at, Some(T0 + 5));
        let stored = app.store().rooms().list_rooms().unwrap();
        assert_eq!(stored[0].last_active_at, Some(T0 + 5));
    }

    #[test]
    fn mark_active_keeps_the_memory_value_when_the_write_fails() {
        let (app, _) = app();
        // No row for this room: the write finds nothing to update and fails; memory must still move.
        let room = crate::room::Room::new(rid("ghost"), RoomInit::default(), T0).unwrap();
        let cell = app.registry.add_room(room, 0.0).unwrap();
        let mut inner = cell.lock();
        app.mark_active(&mut inner, T0 + 9);
        assert_eq!(inner.room.last_active_at, Some(T0 + 9));
    }

    // apps/server/test/room-lifecycle.test.ts:29 removeRoom
    #[test]
    fn removing_a_room_closes_every_socket_joined_or_not_and_leaves_other_rooms_alone() {
        let (app, _) = app();
        let a = add_room(&app, "film-club", RoomInit::default());
        let b = add_room(&app, "lobby", RoomInit::default());
        let (tx1, mut joined) = channel();
        let (tx2, mut lurker) = channel();
        let (tx3, mut other) = channel();
        {
            let mut inner = a.lock();
            inner.subscribers.attach(ConnId(1), tx1);
            inner.subscribers.subscribe(ConnId(1));
            inner.subscribers.attach(ConnId(2), tx2);
        }
        b.lock().subscribers.attach(ConnId(3), tx3);
        assert!(app.remove_room(&rid("film-club"), RemoveReason::Closed));
        assert!(!app.remove_room(&rid("film-club"), RemoveReason::Closed));
        for rx in [&mut joined, &mut lurker] {
            let Some(Outbound::Close(code, reason)) = rx.try_recv() else {
                panic!()
            };
            assert_eq!((code, reason), (4004, "room closed"));
        }
        assert!(other.try_recv().is_none());
        assert!(app.registry.get(&rid("film-club")).is_none());
        assert!(app.registry.get(&rid("lobby")).is_some());
        assert!(a.lock().closed);
    }

    // apps/server/test/takedown.test.ts:107 closes with TAKEN_DOWN
    #[test]
    fn a_takedown_closes_with_taken_down_and_counts_every_close_in_metrics() {
        let (app, _) = app();
        let a = add_room(&app, "film-club", RoomInit::default());
        let (tx, mut rx) = channel();
        a.lock().subscribers.attach(ConnId(1), tx);
        assert!(app.remove_room(&rid("film-club"), RemoveReason::TakenDown));
        let Some(Outbound::Close(code, reason)) = rx.try_recv() else {
            panic!()
        };
        assert_eq!((code, reason), (4006, "room taken down"));
        let text = app.metrics.render(&Default::default());
        assert!(text.contains("code=\"4006\"} 1"), "{text}");
    }

    // apps/server/src/server.ts:299 the store delete hook; ws.ts:377 revokes grants
    #[test]
    fn removal_revokes_grants_and_deletes_the_row() {
        use crate::contract::ids::{MemberId, ShareToken};
        use crate::registry::ShareGrant;
        let (app, _) = app();
        let cell = add_room(&app, "film-club", RoomInit::default());
        let token = ShareToken::parse(&"a".repeat(22)).unwrap();
        cell.lock()
            .insert_grant(&token, ShareGrant::new(MemberId::parse("m1").unwrap(), false, 0.0));
        assert_eq!(app.store().rooms().list_rooms().unwrap().len(), 1);
        app.remove_room(&rid("film-club"), RemoveReason::Closed);
        assert!(cell.lock().grant(&token).is_none());
        assert!(app.store().rooms().list_rooms().unwrap().is_empty());
    }

    // apps/server/src/rooms.ts:55 removeRoom runs the hooks in registration order: reports, ws, store
    #[test]
    fn hooks_run_in_the_ts_registration_order_after_the_registry_lock_is_released() {
        let (app, _) = app();
        let cell = add_room(&app, "film-club", RoomInit::default());
        app.registry.remove(&rid("film-club"));
        let mut seen = Vec::new();
        app.end_room(&cell, RemoveReason::Closed, |h| {
            // The registry is free: a hook (or anything it calls) can look rooms up and add them.
            assert!(app.registry.is_empty());
            seen.push(h);
        });
        assert_eq!(seen, [Hook::Reports, Hook::Sockets, Hook::Store]);
    }

    #[test]
    fn the_hooks_drop_the_rooms_duplicate_marks() {
        let (app, _) = app();
        add_room(&app, "film-club", RoomInit::default());
        app.reports.dedup_add(&rid("film-club"), "k", T0);
        app.reports.dedup_add(&rid("other"), "k", T0);
        app.remove_room(&rid("film-club"), RemoveReason::Closed);
        assert_eq!(app.reports.dedup_size(), 1);
    }

    #[test]
    fn a_failed_row_delete_is_logged_not_fatal_and_the_room_is_gone() {
        let (app, _) = app();
        // Registered but never stored: the delete finds no row (false), which is not an error either.
        let room = crate::room::Room::new(rid("ghost"), RoomInit::default(), T0).unwrap();
        app.registry.add_room(room, 0.0).unwrap();
        assert!(app.remove_room(&rid("ghost"), RemoveReason::Closed));
        assert!(app.registry.is_empty());
    }

    #[test]
    fn with_open_room_runs_on_a_live_room_and_refuses_a_missing_or_removed_one() {
        let (app, _) = app();
        let cell = add_room(&app, "film-club", RoomInit::default());
        assert_eq!(app.with_open_room(&rid("film-club"), |i| i.room.member_count()), Some(0));
        assert_eq!(app.with_open_room(&rid("nope"), |_| ()), None);
        app.remove_room(&rid("film-club"), RemoveReason::Closed);
        assert_eq!(app.with_open_room(&rid("film-club"), |_| ()), None);
        assert!(cell.lock_open().is_none());
    }

    #[test]
    fn insert_room_registers_once_and_the_room_is_reachable() {
        let (app, _) = app();
        let room = crate::room::Room::new(rid("pop-up"), RoomInit::default(), T0).unwrap();
        let cell = app.insert_room(room).unwrap();
        assert!(std::sync::Arc::ptr_eq(&cell, &app.registry.get(&rid("pop-up")).unwrap()));
        let again = crate::room::Room::new(rid("pop-up"), RoomInit::default(), T0).unwrap();
        assert!(app.insert_room(again).is_err());
    }

    // apps/server/src/ws.ts:386 closeAll
    #[test]
    fn close_all_sockets_closes_every_rooms_sockets_and_counts_them() {
        let (app, _) = app();
        let a = add_room(&app, "film-club", RoomInit::default());
        let b = add_room(&app, "lobby", RoomInit::default());
        let (tx1, mut r1) = channel();
        let (tx2, mut r2) = channel();
        let (tx3, mut r3) = channel();
        a.lock().subscribers.attach(ConnId(1), tx1);
        a.lock().subscribers.attach(ConnId(2), tx2);
        b.lock().subscribers.attach(ConnId(3), tx3);
        assert_eq!(app.close_all_sockets(1012, "server restarting"), 3);
        for rx in [&mut r1, &mut r2, &mut r3] {
            let Some(Outbound::Close(code, reason)) = rx.try_recv() else {
                panic!()
            };
            assert_eq!((code, reason), (1012, "server restarting"));
        }
        assert!(app.metrics.render(&Default::default()).contains("code=\"1012\"} 3"));
        assert!(app.registry.get(&rid("lobby")).is_some(), "rooms stay");
    }

    // Each slice fills its own state struct, so S5, S6 and S7 never edit `App` itself.
    #[test]
    fn the_app_carries_one_empty_state_struct_per_slice() {
        let (app, _) = app();
        let _: &crate::http::HttpState = &app.http;
        let _: &crate::ws::WsState = &app.ws;
        let _: &crate::ops::OpsState = &app.ops;
    }

    #[test]
    fn the_per_slice_routers_exist_and_start_empty() {
        let (app, _) = app();
        let _: axum::Router = crate::http::router(app.clone());
        let _: axum::Router = crate::ws::router(app);
    }

    #[test]
    fn the_app_exposes_both_clocks_and_one_store() {
        let (app, clock) = app();
        assert_eq!(app.wall(), T0);
        clock.set_mono(2500.0);
        clock.set_wall(T0 + 1);
        assert_eq!(app.mono(), 2500.0);
        assert_eq!(app.wall(), T0 + 1);
        app.store().rooms().list_rooms().unwrap();
        assert!(!app.title_blocked("fine"));
    }

    #[test]
    fn the_app_takes_its_policy_and_headers_from_the_config() {
        let (on, _) = app_with(config(&[]));
        let (off, _) = app_with(config(&[("GENERIC_EMBEDS", "off")]));
        assert!(on.embeds.generic_embeds && !off.embeds.generic_embeds);
        assert_ne!(on.headers, off.headers);
        let (blocking, _) = app_with(config(&[("ROOM_TITLE_BLOCKLIST", "badword")]));
        assert!(blocking.title_blocked("BAD word"));
    }

    #[test]
    fn a_taken_down_id_in_the_store_is_known_at_startup() {
        let clock = clock();
        let store = Store::open(":memory:").unwrap();
        store.reports().add_takedown(&rid("gone"), T0).unwrap();
        let app = App::new(config(&[]), clock, store).unwrap();
        assert!(app.reports.is_taken_down(&rid("gone")));
        assert!(!app.reports.is_taken_down(&rid("lobby")));
    }

    #[test]
    fn boot_errors_print_as_the_binary_does() {
        let e = BootError::Db {
            path: "/data/omega.db".into(),
            cause: StoreError::Io(std::io::ErrorKind::PermissionDenied),
        };
        assert_eq!(e.to_string(), "DB_PATH /data/omega.db: database file: permission denied");
        let e = BootError::Store(StoreError::CorruptRoom { id: "\"lobby\"".into() });
        assert!(e.to_string().contains("lobby"));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod boot_tests {
    use super::testing::*;
    use super::*;
    use crate::config::DbPath;
    use crate::contract::constants::QUEUE_MAX;
    use crate::contract::layout::default_layout;
    use crate::contract::room::{Avatar, ControlPolicy, RoomVisibility, SeatIndex};
    use crate::contract::text::{Nickname, RoomTitle};
    use crate::room::SEAT_HOLD_MS;
    use crate::secrets::{hash_secret, mint_item_id};
    use crate::store::{NewRoom, StoredQueueItem};

    const YT: &str = "https://youtu.be/dQw4w9WgXcQ";
    const GENERIC: &str = "https://player.example-host.net/embed/42";

    fn file_config(dir: &tempfile::TempDir, extra: &[(&str, &str)]) -> ServerConfig {
        let mut config = config(extra);
        config.db_path = DbPath::File(dir.path().join("omega.db"));
        config
    }

    fn open(dir: &tempfile::TempDir) -> Store {
        Store::open(dir.path().join("omega.db").to_str().unwrap()).unwrap()
    }

    fn boot(config: ServerConfig) -> Result<Arc<App>, BootError> {
        App::boot(config, clock())
    }

    fn room_ids(app: &App) -> Vec<String> {
        app.registry.values().iter().map(|c| c.id.as_str().to_owned()).collect()
    }

    fn nick(name: &str) -> Nickname {
        Nickname::parse(name).unwrap()
    }

    // apps/server/test/persistence.test.ts: the lobby is seeded and stored
    #[test]
    fn a_fresh_database_gets_the_pinned_public_lobby_in_memory_and_in_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let app = boot(file_config(&dir, &[])).unwrap();
        assert_eq!(room_ids(&app), ["lobby"]);
        let cell = app.registry.get(&rid("lobby")).unwrap();
        let inner = cell.lock();
        assert!(inner.room.pinned && inner.room.visibility == RoomVisibility::Public);
        assert_eq!(*inner.room.layout(), default_layout());
        assert!(inner.room.title().is_none());
        drop(inner);
        let rows = app.store().rooms().list_rooms().unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].pinned);
    }

    #[test]
    fn configured_seed_rooms_come_after_the_stored_ones_in_order_and_are_not_seeded_twice() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = open(&dir);
            for (id, at) in [("stored-b", T0 - 10), ("stored-a", T0 - 20)] {
                store
                    .rooms()
                    .create_room(&NewRoom::seed(rid(id), None, at, default_layout()))
                    .unwrap();
            }
        }
        let seeds = [rid("seed-1"), rid("stored-a"), rid("seed-2")];
        let app = App::boot_with(file_config(&dir, &[]), clock(), &seeds).unwrap();
        // Stored rooms oldest first (created_at), then the seeds the store lacked.
        assert_eq!(room_ids(&app), ["stored-a", "stored-b", "seed-1", "seed-2"]);
        assert_eq!(app.store().rooms().list_rooms().unwrap().len(), 4);
        let seeded = app.registry.get(&rid("seed-1")).unwrap();
        assert_eq!(seeded.lock().room.created_at, T0, "stamped with the wall clock");
    }

    // apps/server/test/persistence.test.ts:103, :115
    #[test]
    fn a_stored_embed_comes_back_paused_at_zero_with_the_rooms_settings() {
        let dir = tempfile::tempdir().unwrap();
        let (embed, item) = {
            let store = open(&dir);
            let policy = crate::embed_policy::EmbedPolicy::new(true, &[], &[]).unwrap();
            let embed = policy.accept(YT).unwrap();
            let id = mint_item_id().unwrap();
            let title = Some(RoomTitle::parse("Film club").unwrap());
            let mut new = NewRoom::seed(rid("film-club"), title, T0 - 99, default_layout());
            new.pinned = false;
            new.owner_hash = Some([9; 32]);
            new.visibility = RoomVisibility::Private;
            new.invite_hash = Some([8; 32]);
            store.rooms().create_room(&new).unwrap();
            store.rooms().set_embed(&rid("film-club"), Some(&embed), Some(&id)).unwrap();
            store.rooms().set_control_policy(&rid("film-club"), ControlPolicy::Owner).unwrap();
            store.rooms().set_last_active(&rid("film-club"), T0 - 5).unwrap();
            (embed, id)
        };
        let app = boot(file_config(&dir, &[])).unwrap();
        let cell = app.registry.get(&rid("film-club")).unwrap();
        let inner = cell.lock();
        let room = &inner.room;
        assert_eq!(room.current_embed(), Some(&embed));
        assert_eq!(room.item_id(), Some(&item));
        let pb = room.current_playback().unwrap();
        assert!(!pb.playing && pb.by.is_none());
        assert_eq!(room.title().unwrap().as_str(), "Film club");
        assert!(!room.pinned);
        assert_eq!(room.visibility, RoomVisibility::Private);
        assert_eq!(room.created_at, T0 - 99);
        assert_eq!(room.last_active_at, Some(T0 - 5));
        assert_eq!(room.control_policy(), ControlPolicy::Owner);
        assert!(room.has_owner());
        assert_eq!(room.invite_hash, Some([8; 32]));
        assert_eq!(
            room.item_since(),
            1000.0,
            "current from boot on, on the monotonic clock: ended waits out the debounce again"
        );
    }

    // apps/server/test/generic-embeds.test.ts: switching GENERIC_EMBEDS off hides, the row keeps it
    #[test]
    fn an_embed_the_policy_no_longer_accepts_comes_back_as_none_and_the_row_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = open(&dir);
            let policy = crate::embed_policy::EmbedPolicy::new(true, &[], &[]).unwrap();
            let embed = policy.accept(GENERIC).unwrap();
            store
                .rooms()
                .create_room(&NewRoom::seed(rid("lobby"), None, T0, default_layout()))
                .unwrap();
            store
                .rooms()
                .set_embed(&rid("lobby"), Some(&embed), Some(&mint_item_id().unwrap()))
                .unwrap();
        }
        let app = boot(file_config(&dir, &[("GENERIC_EMBEDS", "off")])).unwrap();
        let cell = app.registry.get(&rid("lobby")).unwrap();
        assert!(cell.lock().room.current_embed().is_none());
        assert!(cell.lock().room.item_id().is_none());
        assert!(app.store().rooms().list_rooms().unwrap()[0].embed.is_some(), "the row keeps it");
        drop(cell);
        drop(app);
        let app = boot(file_config(&dir, &[])).unwrap();
        let restored = app.registry.get(&rid("lobby")).unwrap().lock().room.current_embed().is_some();
        assert!(restored, "switching back restores it");
    }

    // apps/server/test/queue.test.ts:639, :662, :695
    #[test]
    fn a_restored_queue_skips_hidden_rows_and_cuts_past_the_cap_for_good() {
        let dir = tempfile::tempdir().unwrap();
        let policy = crate::embed_policy::EmbedPolicy::new(true, &[], &[]).unwrap();
        let (current, queued) = {
            let store = open(&dir);
            store
                .rooms()
                .create_room(&NewRoom::seed(rid("lobby"), None, T0, default_layout()))
                .unwrap();
            let current = mint_item_id().unwrap();
            store
                .rooms()
                .set_embed(&rid("lobby"), Some(&policy.accept(YT).unwrap()), Some(&current))
                .unwrap();
            let mut ids = Vec::new();
            for i in 0..QUEUE_MAX + 2 {
                let id = mint_item_id().unwrap();
                let embed = policy.accept(&format!("{GENERIC}{i}")).unwrap();
                store
                    .rooms()
                    .add_queue_item(&rid("lobby"), &StoredQueueItem { id: id.clone(), embed })
                    .unwrap();
                ids.push(id);
            }
            (current, ids)
        };
        // Generic embeds off: every queued row is hidden, none is cut.
        let app = boot(file_config(&dir, &[("GENERIC_EMBEDS", "off")])).unwrap();
        assert!(app.registry.get(&rid("lobby")).unwrap().lock().room.queue().is_empty());
        assert_eq!(app.store().rooms().list_rooms().unwrap()[0].queue.len(), QUEUE_MAX + 2);
        drop(app);
        // On again: the oldest QUEUE_MAX are kept, the two past the cap are deleted.
        let app = boot(file_config(&dir, &[])).unwrap();
        let cell = app.registry.get(&rid("lobby")).unwrap();
        let kept: Vec<_> = cell.lock().room.queue().iter().map(|i| i.id.clone()).collect();
        assert_eq!(kept, queued[..QUEUE_MAX]);
        assert_eq!(cell.lock().room.item_id(), Some(&current));
        let stored: Vec<_> = app.store().rooms().list_rooms().unwrap()[0]
            .queue
            .iter()
            .map(|i| i.id.clone())
            .collect();
        assert_eq!(stored, queued[..QUEUE_MAX], "a cut row is gone for good");
        assert!(
            cell.lock().room.queue().iter().all(|i| i.by.is_none()),
            "nobody is known to have added them"
        );
    }

    // apps/server/test/takedown.test.ts:166
    #[test]
    fn a_taken_down_room_is_not_loaded_or_reseeded_and_a_leftover_row_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = open(&dir);
            store
                .rooms()
                .create_room(&NewRoom::seed(rid("lobby"), None, T0, default_layout()))
                .unwrap();
            store
                .rooms()
                .create_room(&NewRoom::seed(rid("gone"), None, T0, default_layout()))
                .unwrap();
            store.reports().add_takedown(&rid("gone"), T0).unwrap();
            store.reports().add_takedown(&rid("seed"), T0).unwrap();
        }
        let app = App::boot_with(file_config(&dir, &[]), clock(), &[rid("seed")]).unwrap();
        assert_eq!(room_ids(&app), ["lobby"]);
        assert!(app.reports.is_taken_down(&rid("gone")));
        let rows: Vec<String> = app
            .store()
            .rooms()
            .list_rooms()
            .unwrap()
            .iter()
            .map(|r| r.id.as_str().to_owned())
            .collect();
        assert_eq!(rows, ["lobby"], "the leftover row is gone and the seed was never created");
    }

    // apps/server/test/persistence.test.ts:134
    #[test]
    fn a_corrupt_row_refuses_to_boot_naming_the_room() {
        let dir = tempfile::tempdir().unwrap();
        drop(boot(file_config(&dir, &[])).unwrap());
        let db = rusqlite::Connection::open(dir.path().join("omega.db")).unwrap();
        db.execute("UPDATE rooms SET layout = ? WHERE id = 'lobby'", [r#"{"furniture":[]}"#])
            .unwrap();
        drop(db);
        let Err(err) = boot(file_config(&dir, &[])) else { panic!("booted") };
        assert!(matches!(err, BootError::Store(_)));
        assert!(err.to_string().contains("lobby"), "{err}");
    }

    #[test]
    fn a_database_that_cannot_be_opened_fails_as_db_path_says() {
        let mut config = config(&[]);
        config.db_path = DbPath::File("/proc/no-such-dir/omega.db".into());
        let Err(err) = boot(config) else { panic!("booted") };
        assert!(err.to_string().starts_with("DB_PATH /proc/no-such-dir/omega.db: "), "{err}");
    }

    // apps/server/test/graceful-restart.test.ts
    #[test]
    fn seat_holds_are_taken_once_and_applied_to_their_rooms_for_the_hold_time() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = open(&dir);
            store
                .rooms()
                .create_room(&NewRoom::seed(rid("lobby"), None, T0, default_layout()))
                .unwrap();
            let hold = SeatHold {
                room_id: rid("lobby"),
                name_hash: hash_secret(&crate::contract::confusables::nickname_key("alice")),
                seat: SeatIndex::new(3).unwrap(),
            };
            store.rooms().save_seat_holds(&[hold]).unwrap();
        }
        let app = boot(file_config(&dir, &[])).unwrap();
        assert!(
            app.store().rooms().take_seat_holds().unwrap().is_empty(),
            "taken once: a crash loop can't replay them"
        );
        let cell = app.registry.get(&rid("lobby")).unwrap();
        let mut inner = cell.lock();
        let alice = inner.room.join(&nick("alice"), Avatar::new(0).unwrap(), None).unwrap().unwrap();
        // The hold runs SEAT_HOLD_MS from the boot's wall clock (T0).
        assert_eq!(inner.room.claim_held_seat(&alice.id, T0 + SEAT_HOLD_MS).map(|s| s.get()), Some(3));
    }

    #[test]
    fn seat_holds_expire_after_the_hold_time() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = open(&dir);
            store
                .rooms()
                .create_room(&NewRoom::seed(rid("lobby"), None, T0, default_layout()))
                .unwrap();
            let hold = SeatHold {
                room_id: rid("lobby"),
                name_hash: hash_secret(&crate::contract::confusables::nickname_key("alice")),
                seat: SeatIndex::new(1).unwrap(),
            };
            store.rooms().save_seat_holds(&[hold]).unwrap();
        }
        let app = boot(file_config(&dir, &[])).unwrap();
        let cell = app.registry.get(&rid("lobby")).unwrap();
        let mut inner = cell.lock();
        let alice = inner.room.join(&nick("alice"), Avatar::new(0).unwrap(), None).unwrap().unwrap();
        assert_eq!(inner.room.claim_held_seat(&alice.id, T0 + SEAT_HOLD_MS + 1), None);
    }

    #[test]
    fn seat_holds_lists_every_seated_member_by_name_hash_in_registry_then_seat_order() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::boot_with(file_config(&dir, &[]), clock(), &[rid("lobby"), rid("second")]).unwrap();
        for (room, name, seat) in [("second", "bob", 2), ("lobby", "alice", 5), ("lobby", "carol", 1)] {
            let cell = app.registry.get(&rid(room)).unwrap();
            let mut inner = cell.lock();
            let m = inner.room.join(&nick(name), Avatar::new(0).unwrap(), None).unwrap().unwrap();
            inner.room.sit(&m.id, SeatIndex::new(seat));
        }
        let holds = app.seat_holds();
        let got: Vec<(&str, u8)> = holds.iter().map(|h| (h.room_id.as_str(), h.seat.get())).collect();
        assert_eq!(got, [("lobby", 1), ("lobby", 5), ("second", 2)]);
        assert_eq!(
            holds[0].name_hash,
            hash_secret(&crate::contract::confusables::nickname_key("carol"))
        );
    }
}
