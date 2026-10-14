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
use crate::contract::constants::close;
use crate::contract::ids::RoomId;
use crate::contract::js_compat::is_js_whitespace;
use crate::contract::unicode_props::{is_punctuation, is_symbol};
use crate::embed_policy::EmbedPolicy;
use crate::headers::{Header, security_headers};
use crate::log::{LogEvent, log_error};
use crate::metrics::Metrics;
use crate::outbox::close_all;
use crate::registry::{Registry, RemoveReason, RoomCell, RoomInner};
use crate::reports::ReportsState;
use crate::secrets::EntropyError;
use crate::store::{Store, StoreError};
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
