//! Port of `apps/server/src/rooms-gc.ts`: room garbage collection (ADR 0028 section 2, OME-904). A sweep is
//! O(rooms) over the in-memory registry and reads no row; expired rooms end through the one removal path, so
//! their sockets close with ROOM_CLOSED, their grants are revoked and their row is deleted.

use crate::app::App;
use crate::contract::ids::RoomId;
use crate::log::{LogEvent, log_error};
use crate::registry::RemoveReason;
use crate::reports;
use crate::room::Room;
use std::sync::Arc;
use tokio::task::JoinHandle;

/// How often GC sweeps; it also sweeps once at boot. A room goes 20-21 min after it emptied.
pub const ROOM_GC_INTERVAL_MS: u64 = 60 * 1000;
/// A room with nobody in it goes this long after the last member left (`last_active_at`), or after
/// `created_at` if nobody ever joined.
pub const ROOM_IDLE_TTL_MS: i64 = 20 * 60 * 1000;

/// Whether GC should end the room at `now` (Unix ms). Pinned rooms never; occupied ones are checked by the caller.
pub fn expired(room: &Room, now: i64) -> bool {
    if room.pinned {
        return false;
    }
    now.saturating_sub(room.last_active_at.unwrap_or(room.created_at)) >= ROOM_IDLE_TTL_MS
}

/// One sweep at `now`: touches every occupied room (its stored `last_active_at` is then at most one interval old
/// if the process dies while they are in it), ends the expired ones, and returns the ids removed, in registry order.
pub fn sweep_rooms(app: &App, now: i64) -> Vec<RoomId> {
    let mut due = Vec::new();
    for cell in app.registry.values() {
        let mut inner = cell.lock();
        if inner.room.member_count() > 0 {
            app.mark_active(&mut inner, now);
        } else if expired(&inner.room, now) {
            due.push(cell.id.clone());
        }
    }
    let mut removed = Vec::new();
    for id in due {
        // Checked again under the registry's and the room's locks: someone may have joined since the pass above.
        let gone = app
            .registry
            .remove_if(&id, |inner| inner.room.member_count() == 0 && expired(&inner.room, now));
        if let Some(cell) = gone {
            app.end_room(&cell, RemoveReason::Closed, |_| {});
            removed.push(id);
        }
    }
    removed
}

/// One sweep, then report retention (ADR 0033 section 3); a failed purge is logged and the next sweep tries again.
fn sweep_once(app: &App) {
    sweep_rooms(app, app.wall());
    if let Err(err) = reports::purge(app) {
        log_error(LogEvent::GcPurge, Some(&err));
    }
}

/// Sweeps now, then every `ROOM_GC_INTERVAL_MS` on the app's clock (so the virtual clock of the test build drives
/// it), purging old reports after each sweep. The task ends when its handle is aborted or the runtime stops.
pub fn spawn_room_gc(app: Arc<App>) -> JoinHandle<()> {
    // The boot sweep runs before this returns, so it is done before the caller starts listening.
    sweep_once(&app);
    tokio::spawn(async move {
        loop {
            app.clock.sleep(ROOM_GC_INTERVAL_MS as f64).await;
            sweep_once(&app);
        }
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::app::testing::*;
    use crate::contract::constants::close;
    use crate::contract::room::RoomVisibility;
    use crate::contract::text::RoomTitle;
    use crate::outbox::{ConnId, Outbound, channel};
    use crate::room::RoomInit;

    const MIN: i64 = 60_000;
    const HOUR: i64 = 60 * MIN;
    const DAY: i64 = 24 * HOUR;
    const ID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ID_C: &str = "cccccccccccccccccccccccccc";

    /// A created room (unpinned, owned) as the store would hand it back.
    fn created(created_at: i64, last_active_at: Option<i64>) -> RoomInit {
        RoomInit {
            pinned: Some(false),
            created_at: Some(created_at),
            last_active_at,
            owner_hash: Some([7; 32]),
            title: Some(RoomTitle::parse("Film club").unwrap()),
            visibility: Some(RoomVisibility::Public),
            ..RoomInit::default()
        }
    }

    fn ids(removed: Vec<RoomId>) -> Vec<String> {
        removed.iter().map(|r| r.as_str().to_owned()).collect()
    }

    // apps/server/test/rooms-gc.test.ts:59
    #[test]
    fn one_idle_rule_twenty_minutes_and_a_minute_between_sweeps() {
        assert_eq!(ROOM_IDLE_TTL_MS, 20 * MIN);
        assert_eq!(ROOM_GC_INTERVAL_MS, 60_000);
    }

    // apps/server/test/rooms-gc.test.ts:63
    #[test]
    fn a_room_nobody_ever_joined_is_kept_for_20_min_after_created_at_then_removed() {
        let (app, _) = app();
        add_room(&app, ID_A, created(T0, None));
        assert!(sweep_rooms(&app, T0 + 19 * MIN).is_empty());
        assert!(sweep_rooms(&app, T0 + 20 * MIN - 1).is_empty());
        assert!(app.registry.get(&rid(ID_A)).is_some());
        assert_eq!(ids(sweep_rooms(&app, T0 + 20 * MIN)), [ID_A]);
        assert!(app.registry.get(&rid(ID_A)).is_none());
    }

    // apps/server/test/rooms-gc.test.ts:73
    #[test]
    fn an_empty_room_is_kept_for_20_min_after_the_last_member_left_however_old_it_is() {
        let (app, _) = app();
        let emptied = T0 + 30 * DAY;
        add_room(&app, ID_A, created(T0, Some(emptied)));
        assert!(sweep_rooms(&app, emptied + 19 * MIN).is_empty());
        assert_eq!(ids(sweep_rooms(&app, emptied + 20 * MIN)), [ID_A]);
    }

    // apps/server/test/rooms-gc.test.ts:83
    #[test]
    fn pinned_rooms_are_never_collected_however_old_and_unused() {
        let (app, _) = app();
        add_room(&app, "lobby", RoomInit::default());
        add_room(
            &app,
            ID_B,
            RoomInit {
                pinned: Some(true),
                created_at: Some(0),
                last_active_at: Some(0),
                ..RoomInit::default()
            },
        );
        assert!(sweep_rooms(&app, T0 + 10_000 * DAY).is_empty());
        assert_eq!(app.registry.len(), 2);
    }

    // apps/server/test/rooms-gc.test.ts:92
    #[test]
    fn only_members_protect_an_expired_room_and_occupied_rooms_are_touched_with_the_sweep_time() {
        let (app, _) = app();
        let occupied = add_room(&app, ID_A, created(T0, Some(T0)));
        let nick = crate::contract::text::Nickname::parse("alice").unwrap();
        occupied
            .lock()
            .room
            .join(&nick, crate::contract::room::Avatar::new(0).unwrap(), None)
            .unwrap()
            .unwrap();
        // A pending socket is not activity.
        let (tx, _rx) = channel();
        let joining = add_room(&app, ID_B, created(T0, None));
        joining.lock().subscribers.attach(ConnId(1), tx);
        add_room(&app, ID_C, created(T0, Some(T0)));
        let now = T0 + 100 * DAY;
        assert_eq!(ids(sweep_rooms(&app, now)), [ID_B, ID_C], "registry order");
        assert!(app.registry.get(&rid(ID_A)).is_some());
        assert!(app.registry.get(&rid(ID_B)).is_none());
        assert_eq!(occupied.lock().room.last_active_at, Some(now));
        let stored = app.store().rooms().list_rooms().unwrap();
        assert_eq!(stored.len(), 1, "the removed rooms' rows went too");
        assert_eq!(stored[0].last_active_at, Some(now));
    }

    // apps/server/test/rooms-gc.test.ts:116
    #[test]
    fn removal_goes_through_the_one_path_sockets_close_with_room_closed_and_the_row_goes() {
        let (app, _) = app();
        let cell = add_room(&app, ID_A, created(T0, None));
        let (tx, mut rx) = channel();
        cell.lock().subscribers.attach(ConnId(1), tx);
        assert_eq!(ids(sweep_rooms(&app, T0 + 2 * HOUR)), [ID_A]);
        let Some(Outbound::Close(code, _)) = rx.try_recv() else { panic!() };
        assert_eq!(code, close::ROOM_CLOSED);
        assert!(cell.lock().closed);
        assert!(app.store().rooms().list_rooms().unwrap().is_empty());
    }

    // apps/server/test/rooms-gc.test.ts (the server's GC: expired created rooms, fresh ones and the pinned lobby)
    #[test]
    fn the_boot_sweep_keeps_the_pinned_lobby_and_fresh_rooms_and_deletes_expired_ones() {
        let (app, _) = app();
        let now = T0 + DAY;
        add_room(&app, "lobby", RoomInit::default());
        add_room(&app, ID_A, created(now - 20 * MIN, None));
        add_room(&app, ID_B, created(T0, Some(now - 25 * MIN)));
        add_room(&app, ID_C, created(T0, Some(now - 19 * MIN)));
        assert_eq!(ids(sweep_rooms(&app, now)), [ID_A, ID_B]);
        let left: Vec<String> = app.registry.values().iter().map(|c| c.id.as_str().to_owned()).collect();
        assert_eq!(left, ["lobby", ID_C]);
    }

    // apps/server/test/rooms-gc.test.ts:150
    #[tokio::test(start_paused = true)]
    async fn sweeps_once_at_start_then_every_interval_until_aborted() {
        let (app, clock) = app();
        add_room(&app, ID_A, created(T0 - 2 * HOUR, None));
        add_room(&app, ID_B, created(T0, None));
        let gc = spawn_room_gc(app.clone());
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert!(app.registry.get(&rid(ID_A)).is_none(), "the boot sweep");
        assert!(app.registry.get(&rid(ID_B)).is_some());
        clock.set_wall(T0 + HOUR);
        tokio::time::advance(std::time::Duration::from_millis(ROOM_GC_INTERVAL_MS)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert!(app.registry.get(&rid(ID_B)).is_none(), "the interval sweep");
        gc.abort();
        let _ = gc.await;
        add_room(&app, ID_C, created(T0, None));
        clock.set_wall(T0 + 3 * HOUR);
        tokio::time::advance(std::time::Duration::from_millis(ROOM_GC_INTERVAL_MS * 3)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert!(app.registry.get(&rid(ID_C)).is_some(), "stopped");
    }

    // apps/server/test/reports.test.ts:418 "the room GC sweep purges them"
    #[tokio::test(start_paused = true)]
    async fn each_sweep_also_purges_old_reports() {
        use crate::contract::constants::REPORT_RETENTION_MS;
        let (app, clock) = app();
        let cell = add_room(&app, "lobby", RoomInit::default());
        let request = crate::contract::requests::parse_report_request(br#"{"reason":"spam"}"#).unwrap();
        crate::reports::file(&app, &mut cell.lock(), "198.51.100.7", &request);
        assert_eq!(crate::reports::open_count(&app).unwrap(), 1);
        clock.set_wall(T0 + REPORT_RETENTION_MS as i64 + 1);
        let gc = spawn_room_gc(app.clone());
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert_eq!(crate::reports::open_count(&app).unwrap(), 0);
        gc.abort();
    }

    #[test]
    fn expired_follows_last_active_then_created_at_and_never_for_pinned() {
        let room = |init: RoomInit| Room::new(rid(ID_A), init, 0).unwrap();
        assert!(expired(&room(created(0, None)), ROOM_IDLE_TTL_MS));
        assert!(!expired(&room(created(0, None)), ROOM_IDLE_TTL_MS - 1));
        assert!(!expired(&room(created(0, Some(5))), ROOM_IDLE_TTL_MS));
        assert!(expired(&room(created(0, Some(5))), 5 + ROOM_IDLE_TTL_MS));
        assert!(!expired(&room(RoomInit::default()), i64::MAX));
    }
}
