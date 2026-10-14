//! Port of `apps/server/src/store/db.ts`: open, pragmas, forward-only migrations.

use super::StoreError;
use rusqlite::Connection;

/// One forward-only migration: `NNNN-name.sql` and its text.
#[derive(Debug, Clone, Copy)]
pub struct Migration<'a> {
    pub file: &'a str,
    pub sql: &'a str,
}

/// `apps/server/migrations`, embedded: the TS server and this one run the very same files. A new file
/// there must be added here (a test compares the directory with this list).
pub const MIGRATIONS: [Migration<'static>; 6] = [
    Migration {
        file: "0001-rooms.sql",
        sql: include_str!("../../../server/migrations/0001-rooms.sql"),
    },
    Migration {
        file: "0002-created-rooms.sql",
        sql: include_str!("../../../server/migrations/0002-created-rooms.sql"),
    },
    Migration {
        file: "0003-seat-holds.sql",
        sql: include_str!("../../../server/migrations/0003-seat-holds.sql"),
    },
    Migration {
        file: "0004-control-policy.sql",
        sql: include_str!("../../../server/migrations/0004-control-policy.sql"),
    },
    Migration {
        file: "0005-queue.sql",
        sql: include_str!("../../../server/migrations/0005-queue.sql"),
    },
    Migration {
        file: "0006-reports.sql",
        sql: include_str!("../../../server/migrations/0006-reports.sql"),
    },
];

/// `openDatabase` with the embedded migrations.
pub fn open_database(path: &str) -> Result<Connection, StoreError> {
    open_database_with(path, &MIGRATIONS)
}

/// `openDatabase` with a given list (tests).
pub fn open_database_with(path: &str, migrations: &[Migration<'_>]) -> Result<Connection, StoreError> {
    let _ = (path, migrations);
    Err(StoreError::Invalid("stub"))
}

/// The schema version this binary migrates to.
pub fn latest_migration() -> usize {
    0
}

/// `PRAGMA wal_checkpoint(TRUNCATE)`.
pub fn checkpoint(conn: &Connection) -> Result<(), StoreError> {
    let _ = conn;
    Err(StoreError::Invalid("stub"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn tmp() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("omega.db").to_string_lossy().into_owned();
        (dir, path)
    }
    fn user_version(c: &Connection) -> i64 {
        c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }
    fn pragma(c: &Connection, name: &str) -> rusqlite::types::Value {
        c.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0)).unwrap()
    }
    fn m<'a>(file: &'a str, sql: &'a str) -> Migration<'a> {
        Migration { file, sql }
    }
    fn mode(path: &str) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    // apps/server/test/store.test.ts:50
    #[test]
    fn a_file_database_runs_in_wal_with_normal_sync_foreign_keys_and_a_2s_busy_timeout() {
        let (_d, path) = tmp();
        let c = open_database(&path).unwrap();
        assert_eq!(pragma(&c, "journal_mode"), rusqlite::types::Value::Text("wal".into()));
        assert_eq!(pragma(&c, "synchronous"), rusqlite::types::Value::Integer(1));
        assert_eq!(pragma(&c, "foreign_keys"), rusqlite::types::Value::Integer(1));
        assert_eq!(pragma(&c, "busy_timeout"), rusqlite::types::Value::Integer(2000));
    }

    // apps/server/test/store.test.ts:58
    #[test]
    fn creates_the_database_file_with_mode_0600() {
        let (_d, path) = tmp();
        open_database(&path).unwrap();
        assert_eq!(mode(&path), 0o600);
    }

    // apps/server/test/store.test.ts:64
    #[test]
    fn tightens_an_existing_world_readable_file_to_0600() {
        let (_d, path) = tmp();
        std::fs::write(&path, "").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        open_database(&path).unwrap();
        assert_eq!(mode(&path), 0o600);
    }

    #[test]
    fn creates_the_parent_directory_owner_only() {
        let (d, _) = tmp();
        let path: PathBuf = d.path().join("data").join("omega.db");
        open_database(&path.to_string_lossy()).unwrap();
        assert_eq!(
            std::fs::metadata(d.path().join("data")).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    // apps/server/test/store.test.ts:72
    #[test]
    fn every_migration_runs_from_empty_and_rooms_has_the_schema() {
        let c = open_database(":memory:").unwrap();
        assert_eq!(user_version(&c), 6);
        assert_eq!(latest_migration(), 6);
        let strict: i64 = c
            .query_row("SELECT strict FROM pragma_table_list WHERE name = 'rooms'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(strict, 1);
        let cols: Vec<String> = c
            .prepare("SELECT name || ':' || type || ':' || \"notnull\" || ':' || pk FROM pragma_table_info('rooms')")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            cols,
            [
                "id:TEXT:1:1",
                "title:TEXT:1:0",
                "created_at:INTEGER:1:0",
                "layout:TEXT:1:0",
                "embed:TEXT:0:0",
                "visibility:TEXT:1:0",
                "pinned:INTEGER:1:0",
                "owner_hash:BLOB:0:0",
                "invite_hash:BLOB:0:0",
                "last_active_at:INTEGER:0:0",
                "control_policy:TEXT:1:0",
                "item_id:TEXT:0:0",
            ]
        );
        let long = "a".repeat(33);
        assert!(
            c.execute("INSERT INTO rooms (id, created_at, layout) VALUES (?, 0, '{}')", [long])
                .is_err()
        );
    }

    // apps/server/test/store.test.ts:107
    #[test]
    fn a_fixture_at_version_n_minus_1_upgrades_and_keeps_its_rows() {
        let (_d, path) = tmp();
        {
            let f = Connection::open(&path).unwrap();
            f.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT; INSERT INTO t (id) VALUES (7); PRAGMA user_version = 1;")
                .unwrap();
        }
        let list = [
            m("0001-rooms.sql", "CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT;"),
            m("0002-name.sql", "ALTER TABLE t ADD COLUMN name TEXT NOT NULL DEFAULT 'x';"),
        ];
        let c = open_database_with(&path, &list).unwrap();
        assert_eq!(user_version(&c), 2);
        let row: (i64, String) = c.query_row("SELECT id, name FROM t", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(row, (7, "x".into()));
    }

    // apps/server/test/store.test.ts:124
    #[test]
    fn the_real_migrations_upgrade_a_database_at_n_minus_1() {
        let (_d, path) = tmp();
        drop(open_database_with(&path, &MIGRATIONS[..5]).unwrap());
        let c = open_database(&path).unwrap();
        assert_eq!(user_version(&c), 6);
    }

    // apps/server/test/store.test.ts:134
    #[test]
    fn refuses_to_start_when_the_database_is_newer() {
        let (_d, path) = tmp();
        Connection::open(&path).unwrap().execute_batch("PRAGMA user_version = 7").unwrap();
        assert_eq!(open_database(&path).unwrap_err(), StoreError::SchemaNewer { found: 7, known: 6 });
    }

    // apps/server/test/store.test.ts:143
    #[test]
    fn a_failing_migration_rolls_back_whole_and_leaves_user_version() {
        let (_d, path) = tmp();
        let list = [
            m("0001-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;"),
            m(
                "0002-b.sql",
                "CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT; INSERT INTO nope VALUES (1);",
            ),
        ];
        let err = open_database_with(&path, &list).unwrap_err();
        assert!(
            matches!(&err, StoreError::Migration { file, .. } if file == "0002-b.sql"),
            "{err:?}"
        );
        assert!(err.to_string().contains("0002-b.sql"));
        let c = Connection::open(&path).unwrap();
        assert_eq!(user_version(&c), 1);
        let n: i64 = c
            .query_row("SELECT count(*) FROM sqlite_schema WHERE name = 'b'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    // apps/server/test/store.test.ts:156
    #[test]
    fn refuses_a_list_with_a_gap_or_a_duplicate_number() {
        let gap = [m("0001-a.sql", "SELECT 1;"), m("0003-c.sql", "SELECT 1;")];
        assert_eq!(
            open_database_with(":memory:", &gap).unwrap_err(),
            StoreError::MigrationOrder { file: "0003-c.sql".into() }
        );
        let dup = [m("0001-a.sql", "SELECT 1;"), m("0001-b.sql", "SELECT 1;")];
        assert_eq!(
            open_database_with(":memory:", &dup).unwrap_err(),
            StoreError::MigrationOrder { file: "0001-b.sql".into() }
        );
        let bad = [m("1-a.sql", "SELECT 1;")];
        assert!(open_database_with(":memory:", &bad).is_err());
    }

    /// The TS server's migrations directory is the source: nothing may be missing here or extra.
    #[test]
    fn the_embedded_list_is_the_directory() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../server/migrations");
        let mut files: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        files.sort();
        let embedded: Vec<&str> = MIGRATIONS.iter().map(|m| m.file).collect();
        assert_eq!(files, embedded);
        for (i, mig) in MIGRATIONS.iter().enumerate() {
            assert!(mig.file.starts_with(&format!("{:04}-", i + 1)));
        }
    }

    #[test]
    fn checkpoint_truncates_the_wal() {
        let (_d, path) = tmp();
        let c = open_database(&path).unwrap();
        c.execute("INSERT INTO takedowns (room_id, at) VALUES ('a', 1)", []).unwrap();
        checkpoint(&c).unwrap();
        assert_eq!(std::fs::metadata(format!("{path}-wal")).unwrap().len(), 0);
    }
}
