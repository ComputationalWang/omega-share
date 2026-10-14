//! The graceful restart (OME-504, ADR 0032; `shutdown` in apps/server/src/index.ts): stop accepting, close every
//! socket with SERVICE_RESTART (clients reconnect on their own), keep the seats for the next boot, then checkpoint
//! and close the database. systemd sends SIGTERM on `restart` and `stop` (deploy/omega-share.service,
//! TimeoutStopSec). `serve.rs` runs the sequence; this file holds the two steps that touch the app.

use crate::app::App;
use crate::log::{LogEvent, log_error};
use crate::metrics::SERVICE_RESTART;
use crate::store::{SeatHold, StoreError};

/// `server.drain()` after the listener stopped: every socket of every room gets a SERVICE_RESTART close (counted in
/// the metrics) and the seats held are returned for the store to keep.
pub fn drain_sockets(app: &App) -> Vec<SeatHold> {
    // S6 wires drain: until `ws::drain` is in main this is the app core's `seat_holds` and `close_all_sockets`.
    let holds = app.seat_holds();
    app.close_all_sockets(SERVICE_RESTART, "server restarting");
    holds
}

/// What follows the drain: the seats are saved (a failure is logged as `store.seat_holds`, the restart goes on), then
/// `PRAGMA wal_checkpoint(TRUNCATE)`. `Err` if the checkpoint failed: the caller logs `shutdown` and exits 1.
pub fn finish(app: &App, holds: &[SeatHold]) -> Result<(), StoreError> {
    let saved = app.store().rooms().save_seat_holds(holds);
    if let Err(err) = saved {
        log_error(LogEvent::StoreSeatHolds, Some(&err));
    }
    app.store().checkpoint()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::app::App;
    use crate::app::testing::{T0, add_room, app, clock, config, rid};
    use crate::contract::constants::close;
    use crate::contract::room::{Avatar, SeatIndex};
    use crate::contract::text::Nickname;
    use crate::outbox::{ConnId, Outbound, channel};
    use crate::room::RoomInit;
    use crate::store::Store;

    fn seated(app: &App, room: &str, member: &str, name: &str, seat: u64) {
        let cell = app.registry.get(&rid(room)).unwrap();
        let mut inner = cell.lock();
        let id = crate::contract::ids::MemberId::parse(member).unwrap();
        inner
            .room
            .join_with_id(id.clone(), &Nickname::parse(name).unwrap(), Avatar::new(0).unwrap(), None)
            .unwrap();
        inner.room.sit(&id, SeatIndex::new(seat));
    }

    // apps/server/test/graceful-restart.test.ts:32
    #[test]
    fn drain_closes_every_socket_with_service_restart_and_returns_the_seats_as_name_hashes() {
        let (app, _) = app();
        add_room(&app, "lobby", RoomInit::default());
        add_room(&app, "other", RoomInit::default());
        seated(&app, "lobby", "m1", "alice-nick", 2);
        seated(&app, "other", "m2", "bob-nick", 0);
        let mut receivers = Vec::new();
        for room in ["lobby", "other", "lobby"] {
            let (outbox, rx) = channel();
            app.registry.get(&rid(room)).unwrap().lock().attach_socket(ConnId::next(), outbox).unwrap();
            receivers.push(rx);
        }
        let holds = drain_sockets(&app);
        for rx in &mut receivers {
            assert!(matches!(rx.try_recv(), Some(Outbound::Close(1012, _))), "closed with SERVICE_RESTART");
        }
        let mut seats: Vec<(String, u8)> = holds.iter().map(|h| (h.room_id.as_str().to_owned(), h.seat.get())).collect();
        seats.sort();
        assert_eq!(seats, [("lobby".to_owned(), 2u8), ("other".to_owned(), 0u8)]);
        for h in &holds {
            assert!(!h.name_hash.windows(4).any(|w| w == b"nick"), "a hash, never the name");
        }
        let text = app.metrics.render(&crate::metrics::Gauges::default());
        assert!(text.contains("omega_ws_closes_total{code=\"1012\"} 3\n"), "{text}");
        let _ = close::ROOM_CLOSED;
    }

    fn file_app(dir: &std::path::Path) -> App {
        let path = dir.join("omega.db");
        let config = config(&[("DB_PATH", path.to_str().unwrap())]);
        App::new(config, clock(), Store::open(path.to_str().unwrap()).unwrap()).unwrap()
    }

    // apps/server/test/graceful-restart.test.ts:122, apps/server/src/index.ts:68
    #[test]
    fn finish_saves_the_holds_for_the_next_boot_once_and_checkpoints_the_wal() {
        let dir = tempfile::tempdir().unwrap();
        let app = file_app(dir.path());
        for id in ["lobby", "gone"] {
            app.store()
                .rooms()
                .create_room(&crate::store::NewRoom::seed(rid(id), None, T0, crate::contract::layout::default_layout()))
                .unwrap();
        }
        let hold = |room: &str, byte: u8, seat: u64| SeatHold {
            room_id: rid(room),
            name_hash: [byte; 32],
            seat: SeatIndex::new(seat).unwrap(),
        };
        let holds = [hold("lobby", 1, 0), hold("gone", 2, 4)];
        assert!(std::fs::metadata(dir.path().join("omega.db-wal")).unwrap().len() > 0, "rows still in the WAL");
        finish(&app, &holds).unwrap();
        assert_eq!(std::fs::metadata(dir.path().join("omega.db-wal")).map_or(0, |m| m.len()), 0, "WAL emptied");
        // The next boot takes them once; a room the holds name that is gone is ignored by the store.
        app.store().rooms().delete_room(&rid("gone")).unwrap();
        let taken = app.store().rooms().take_seat_holds().unwrap();
        assert_eq!(taken.iter().map(|h| (h.room_id.as_str(), h.seat.get())).collect::<Vec<_>>(), [("lobby", 0)]);
        assert!(app.store().rooms().take_seat_holds().unwrap().is_empty());
    }
}
