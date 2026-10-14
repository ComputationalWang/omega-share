//! Port of `apps/server/src/store/reports.ts`: abuse reports and takedowns (migration 0006).

use super::StoreError;
use crate::contract::constants::REPORT_MAX_OPEN;
use crate::contract::ids::{RoomId, string_newtype};
use rusqlite::Connection;

/// Most rows `reports` holds, whatever their state (ADR 0033 §3, QA on OME-604): past this the oldest
/// closed rows make room.
pub const REPORT_MAX_ROWS: usize = 5 * REPORT_MAX_OPEN;

string_newtype!(
    /// 16 random bytes, base64url: the operator's handle, never sent to the reporter. `^[A-Za-z0-9_-]{22}$`.
    ReportId,
    |s| (s.len() == 22 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).then(|| s.to_owned())
);

/// One report as written: the room's snapshot at report time, nothing about the reporter (ADR 0033 §3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewReport {
    pub id: ReportId,
    pub room_id: RoomId,
    /// One of `REPORT_REASONS`. A plain string until the contract's `ReportReason` (S2e) lands; checked on
    /// write and on read.
    pub reason: String,
    /// Parsed and redacted; `None` without a note.
    pub note: Option<String>,
    /// The room's title at report time; `None` for an untitled room.
    pub room_title: Option<String>,
    /// The canonical URL of what was playing; `None` with nothing playing.
    pub embed_url: Option<String>,
    /// Unix ms.
    pub created_at: i64,
}

/// The report tables over the process's connection.
pub struct ReportStore<'a> {
    conn: &'a Connection,
}

impl<'a> ReportStore<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// `GET /healthz`'s database check: reads the schema version, which fails if the database is unreadable.
    pub fn ping(&self) -> Result<(), StoreError> {
        let _ = self.conn;
        Err(StoreError::Invalid("stub"))
    }

    /// Stores one report; past `REPORT_MAX_ROWS` the oldest closed rows go first, in the same transaction.
    pub fn add(&self, report: &NewReport) -> Result<(), StoreError> {
        let _ = report;
        Err(StoreError::Invalid("stub"))
    }

    pub fn open_count(&self) -> Result<usize, StoreError> {
        Err(StoreError::Invalid("stub"))
    }

    /// Open reports, newest first. A row that fails the contract is left out and logged.
    pub fn list_open(&self) -> Result<Vec<NewReport>, StoreError> {
        Err(StoreError::Invalid("stub"))
    }

    /// False if there is no open report with that id.
    pub fn dismiss(&self, id: &ReportId) -> Result<bool, StoreError> {
        let _ = id;
        Err(StoreError::Invalid("stub"))
    }

    /// Dismisses the room's open reports; returns how many.
    pub fn dismiss_room(&self, room_id: &RoomId) -> Result<usize, StoreError> {
        let _ = room_id;
        Err(StoreError::Invalid("stub"))
    }

    /// A takedown: the room's open reports become `actioned`; returns how many.
    pub fn action_room(&self, room_id: &RoomId) -> Result<usize, StoreError> {
        let _ = room_id;
        Err(StoreError::Invalid("stub"))
    }

    /// Retention (ADR 0033 §3): deletes every row created before `before`, whatever its state.
    pub fn purge(&self, before: i64) -> Result<usize, StoreError> {
        let _ = before;
        Err(StoreError::Invalid("stub"))
    }

    /// True when this wrote the tombstone; false when the id was already taken down.
    pub fn add_takedown(&self, room_id: &RoomId, at: i64) -> Result<bool, StoreError> {
        let _ = (room_id, at);
        Err(StoreError::Invalid("stub"))
    }

    /// Every taken-down room id. A row that isn't a room id can't match one, and is skipped.
    pub fn takedowns(&self) -> Result<Vec<RoomId>, StoreError> {
        Err(StoreError::Invalid("stub"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::db::{latest_migration, open_database};
    use std::cell::Cell;
    use std::collections::BTreeMap;

    const T0: i64 = 1_791_504_000_000;
    const ROOM: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn rid(s: &str) -> RoomId {
        RoomId::parse(s).unwrap()
    }
    fn mem() -> Connection {
        open_database(":memory:").unwrap()
    }
    thread_local!(static N: Cell<u32> = const { Cell::new(0) });
    fn report_id() -> ReportId {
        let n = N.with(|c| {
            c.set(c.get() + 1);
            c.get()
        });
        ReportId::parse(&format!("r{n:021}")).unwrap()
    }
    fn report() -> NewReport {
        NewReport {
            id: report_id(),
            room_id: rid(ROOM),
            reason: "spam".into(),
            note: None,
            room_title: Some("Film club".into()),
            embed_url: None,
            created_at: T0,
        }
    }
    fn states(c: &Connection) -> BTreeMap<String, i64> {
        c.prepare("SELECT state, count(*) FROM reports GROUP BY state")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }
    fn st(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect()
    }

    // apps/server/test/report-store.test.ts:26
    #[test]
    fn migration_0006_is_the_newest_and_reports_has_exactly_the_adr_columns() {
        assert_eq!(latest_migration(), 6);
        let c = mem();
        let cols = |t: &str| -> Vec<String> {
            c.prepare(&format!("SELECT name FROM pragma_table_info('{t}')"))
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(
            cols("reports"),
            ["id", "room_id", "reason", "note", "room_title", "embed_url", "created_at", "state"]
        );
        assert_eq!(cols("takedowns"), ["room_id", "at"]);
    }

    // apps/server/test/report-store.test.ts:44
    #[test]
    fn add_then_list_open_returns_the_rows_as_stored_newest_first() {
        let c = mem();
        let s = ReportStore::new(&c);
        let a = NewReport {
            id: ReportId::parse(&"a".repeat(22)).unwrap(),
            reason: "hate".into(),
            note: Some("slurs in the title".into()),
            ..report()
        };
        let b = NewReport {
            id: ReportId::parse(&"b".repeat(22)).unwrap(),
            reason: "sexual".into(),
            embed_url: Some("https://www.youtube-nocookie.com/embed/aaaaaaaaaaa".into()),
            created_at: T0 + 1,
            ..report()
        };
        s.add(&a).unwrap();
        s.add(&b).unwrap();
        assert_eq!(s.list_open().unwrap(), [b, a]);
        assert_eq!(s.open_count().unwrap(), 2);
    }

    // apps/server/test/report-store.test.ts:57
    #[test]
    fn an_invalid_reason_is_refused_and_nothing_is_stored() {
        let c = mem();
        let s = ReportStore::new(&c);
        assert_eq!(
            s.add(&NewReport {
                reason: "illegal".into(),
                ..report()
            }),
            Err(StoreError::Invalid("reason"))
        );
        assert!(ReportId::parse("short").is_none());
        for (bad, what) in [
            (
                NewReport {
                    note: Some("x".repeat(1025)),
                    ..report()
                },
                "note",
            ),
            (
                NewReport {
                    room_title: Some("x".repeat(1025)),
                    ..report()
                },
                "room_title",
            ),
            (
                NewReport {
                    embed_url: Some("x".repeat(2049)),
                    ..report()
                },
                "embed_url",
            ),
            (
                NewReport {
                    created_at: -1,
                    ..report()
                },
                "created_at",
            ),
        ] {
            assert_eq!(s.add(&bad), Err(StoreError::Invalid(what)));
        }
        assert_eq!(s.open_count().unwrap(), 0);
    }

    #[test]
    fn text_caps_count_utf16_units_like_valibot() {
        let c = mem();
        let s = ReportStore::new(&c);
        // 512 astral characters are 1024 units: allowed; 513 are 1026: refused.
        s.add(&NewReport {
            note: Some("\u{1F600}".repeat(512)),
            ..report()
        })
        .unwrap();
        assert_eq!(
            s.add(&NewReport {
                note: Some("\u{1F600}".repeat(513)),
                ..report()
            }),
            Err(StoreError::Invalid("note"))
        );
    }

    // apps/server/test/report-store.test.ts:68
    #[test]
    fn a_corrupt_row_is_left_out_of_list_open_not_failed() {
        let c = mem();
        let s = ReportStore::new(&c);
        s.add(&report()).unwrap();
        c.execute("INSERT INTO reports (id, room_id, reason, note, room_title, embed_url, created_at, state) VALUES (?, ?, 'nonsense', NULL, NULL, NULL, 1, 'open')", ["z".repeat(22), ROOM.to_owned()]).unwrap();
        c.execute("INSERT INTO reports (id, room_id, reason, note, room_title, embed_url, created_at, state) VALUES (?, 'Bad Room', 'spam', NULL, NULL, NULL, 1, 'open')", ["y".repeat(22)]).unwrap();
        assert_eq!(s.list_open().unwrap().len(), 1);
    }

    // apps/server/test/report-store.test.ts:80
    #[test]
    fn dismiss_marks_one_open_report_dismissed_false_for_unknown_or_closed() {
        let c = mem();
        let s = ReportStore::new(&c);
        let r = report();
        s.add(&r).unwrap();
        assert!(s.dismiss(&r.id).unwrap());
        assert!(!s.dismiss(&r.id).unwrap());
        assert!(!s.dismiss(&ReportId::parse(&"q".repeat(22)).unwrap()).unwrap());
        assert_eq!(s.open_count().unwrap(), 0);
        assert!(s.list_open().unwrap().is_empty());
    }

    // apps/server/test/report-store.test.ts:92
    #[test]
    fn dismiss_room_and_action_room_close_only_that_rooms_open_reports() {
        let c = mem();
        let s = ReportStore::new(&c);
        s.add(&report()).unwrap();
        s.add(&report()).unwrap();
        s.add(&NewReport {
            room_id: rid(OTHER),
            ..report()
        })
        .unwrap();
        assert_eq!(s.dismiss_room(&rid(ROOM)).unwrap(), 2);
        assert_eq!(s.dismiss_room(&rid(ROOM)).unwrap(), 0);
        s.add(&report()).unwrap();
        assert_eq!(s.action_room(&rid(ROOM)).unwrap(), 1);
        assert_eq!(states(&c), st(&[("open", 1), ("dismissed", 2), ("actioned", 1)]));
    }

    // apps/server/test/report-store.test.ts:105
    #[test]
    fn purge_deletes_every_row_created_before_the_cutoff_whatever_its_state() {
        let c = mem();
        let s = ReportStore::new(&c);
        s.add(&NewReport {
            created_at: T0,
            ..report()
        })
        .unwrap();
        let closed = NewReport {
            created_at: T0 + 1,
            ..report()
        };
        s.add(&closed).unwrap();
        s.dismiss(&closed.id).unwrap();
        s.add(&NewReport {
            created_at: T0 + 10,
            ..report()
        })
        .unwrap();
        assert_eq!(s.purge(T0 + 10).unwrap(), 2);
        assert_eq!(states(&c), st(&[("open", 1)]));
    }

    // apps/server/test/report-store.test.ts:119
    #[test]
    fn rows_stay_bounded_past_the_cap_the_oldest_closed_rows_make_room() {
        let c = mem();
        let s = ReportStore::new(&c);
        let cap = i64::try_from(REPORT_MAX_ROWS).unwrap();
        for i in 0..cap {
            s.add(&NewReport {
                created_at: T0 + i,
                ..report()
            })
            .unwrap();
        }
        // Close all but the newest 10.
        c.execute("UPDATE reports SET state = 'dismissed' WHERE created_at < ?", [T0 + cap - 10])
            .unwrap();
        s.add(&NewReport {
            created_at: T0 + cap,
            ..report()
        })
        .unwrap();
        let (n, oldest): (i64, i64) = c
            .query_row("SELECT count(*), min(created_at) FROM reports", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((n, oldest), (cap, T0 + 1));
        assert_eq!(s.open_count().unwrap(), 11);
    }

    // apps/server/test/report-store.test.ts:134
    #[test]
    fn takedowns_are_kept_and_listed_back() {
        let c = mem();
        let s = ReportStore::new(&c);
        assert!(s.add_takedown(&rid(ROOM), T0).unwrap());
        assert!(!s.add_takedown(&rid(ROOM), T0 + 5).unwrap());
        assert!(s.add_takedown(&rid(OTHER), T0 + 1).unwrap());
        let mut got: Vec<String> = s.takedowns().unwrap().iter().map(|r| r.as_str().to_owned()).collect();
        got.sort();
        assert_eq!(got, [ROOM, OTHER]);
        assert_eq!(s.add_takedown(&rid("c"), -1), Err(StoreError::Invalid("at")));
        // The first write's time is kept.
        let at: i64 = c
            .query_row("SELECT at FROM takedowns WHERE room_id = ?", [ROOM], |r| r.get(0))
            .unwrap();
        assert_eq!(at, T0);
    }

    #[test]
    fn a_takedown_row_that_is_not_a_room_id_is_skipped() {
        let c = mem();
        c.execute("INSERT INTO takedowns (room_id, at) VALUES ('Not A Room', 1), (?, 2)", [ROOM])
            .unwrap();
        assert_eq!(ReportStore::new(&c).takedowns().unwrap(), [rid(ROOM)]);
    }

    #[test]
    fn ping_reads_the_schema_version() {
        let c = mem();
        assert_eq!(ReportStore::new(&c).ping(), Ok(()));
    }
}
