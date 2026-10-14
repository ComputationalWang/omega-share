//! Port of `apps/server/src/store/db.ts`: open, pragmas, forward-only migrations.

use super::StoreError;
use rusqlite::config::DbConfig;
use rusqlite::{Connection, OpenFlags};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::Duration;

/// One forward-only migration: `NNNN-name.sql` and its text.
#[derive(Debug, Clone, Copy)]
pub struct Migration<'a> {
    pub file: &'a str,
    pub sql: &'a str,
}

/// `apps/server/migrations`, embedded: the TS server and this one run the very same files, so this binary
/// never runs a migration the TS server does not know. A new file there must be added here (a test
/// compares the directory with this list).
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

/// `^\d{4}-[a-z0-9-]+\.sql$`
fn is_migration_name(file: &str) -> bool {
    let (Some(num), Some(tail)) = (file.get(..4), file.get(4..)) else {
        return false;
    };
    let Some(name) = tail.strip_prefix('-').and_then(|t| t.strip_suffix(".sql")) else {
        return false;
    };
    num.bytes().all(|b| b.is_ascii_digit())
        && !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Numbered 0001, 0002, … with no gap or duplicate, so `user_version` names exactly one file.
fn check_order(migrations: &[Migration<'_>]) -> Result<(), StoreError> {
    for (i, m) in migrations.iter().enumerate() {
        let expected = format!("{:04}", i + 1);
        if !is_migration_name(m.file) || m.file.get(..4) != Some(expected.as_str()) {
            return Err(StoreError::MigrationOrder { file: m.file.to_owned() });
        }
    }
    Ok(())
}

/// The schema version this binary migrates to: the newest migration's number.
pub fn latest_migration() -> usize {
    MIGRATIONS.len()
}

fn user_version(conn: &Connection) -> Result<i64, StoreError> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Applies every migration newer than `user_version`, each in its own transaction.
fn migrate(conn: &Connection, migrations: &[Migration<'_>]) -> Result<(), StoreError> {
    check_order(migrations)?;
    let current = user_version(conn)?;
    let done = match usize::try_from(current) {
        Ok(done) if done <= migrations.len() => done,
        _ => {
            return Err(StoreError::SchemaNewer {
                found: current,
                known: migrations.len(),
            });
        }
    };
    for (i, m) in migrations.iter().enumerate().skip(done) {
        let apply = || -> rusqlite::Result<()> {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(m.sql)?;
            tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
            tx.commit()
        };
        // Only the file name and SQLite's result code: its message can quote data.
        apply().map_err(|e| StoreError::Migration {
            file: m.file.to_owned(),
            code: StoreError::from(e).code(),
        })?;
    }
    Ok(())
}

/// Creates the file (and its directory) owner-only, and tightens an existing file to 0600 (D5).
fn ensure_private_file(path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

/// Every connection to a database file goes through here (the server's own and the backup tool's, which opens
/// operator-supplied snapshots): defensive mode (no `writable_schema`, no writes to shadow tables) and an untrusted
/// schema (a view or trigger in a hostile file cannot call risky functions). A relative path gets a `./`: the
/// bundled SQLite is built with SQLITE_USE_URI (the flag cannot turn that off) and Bun's `new Database(path)` takes
/// a `file:` path as a file name, so it must never start with `file:`.
pub fn open_raw(path: &Path, flags: OpenFlags) -> rusqlite::Result<Connection> {
    let flags = flags | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = if path.is_absolute() {
        Connection::open_with_flags(path, flags)?
    } else {
        Connection::open_with_flags(Path::new(".").join(path), flags)?
    };
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    Ok(conn)
}

/// `openDatabase` with the embedded migrations.
pub fn open_database(path: &str) -> Result<Connection, StoreError> {
    open_database_with(path, &MIGRATIONS)
}

/// Opens the process's one database: WAL, synchronous=NORMAL, foreign keys on, 2 s busy timeout, then runs
/// the migrations. Fails if the file is newer than the code.
pub fn open_database_with(path: &str, migrations: &[Migration<'_>]) -> Result<Connection, StoreError> {
    let conn = if path == ":memory:" {
        Connection::open_in_memory()?
    } else {
        ensure_private_file(Path::new(path)).map_err(|e| StoreError::Io(e.kind()))?;
        open_raw(Path::new(path), OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)?
    };
    // `journal_mode` answers with a row, so it is a query.
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    // secure_delete FAST: a taken-down room's title or a deleted report's note is overwritten in the page, not left
    // in a free page. journal_size_limit: the WAL is truncated to 4 MiB after a checkpoint instead of keeping its
    // peak size. Both are per connection, so the file format (and the TS server on the same file) is unchanged.
    conn.execute_batch(
        "PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = FAST; PRAGMA journal_size_limit = 4194304;",
    )?;
    conn.busy_timeout(Duration::from_millis(2000))?;
    migrate(&conn, migrations)?;
    Ok(conn)
}

/// `PRAGMA wal_checkpoint(TRUNCATE)`.
pub fn checkpoint(conn: &Connection) -> Result<(), StoreError> {
    Ok(conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?)
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

    // L3: no extension can be loaded, even if a statement reaches `load_extension`.
    #[test]
    fn load_extension_does_not_exist() {
        let (_d, path) = tmp();
        let c = open_database(&path).unwrap();
        let err = c.query_row("SELECT load_extension('x')", [], |_| Ok(())).unwrap_err();
        assert!(err.to_string().contains("no such function"), "{err}");
    }

    // L3: defensive mode (no writable_schema, no raw shadow-table writes) and untrusted schema on every connection.
    #[test]
    fn every_connection_is_defensive_with_an_untrusted_schema() {
        let (_d, path) = tmp();
        let main = open_database(&path).unwrap();
        let raw = open_raw(Path::new(&path), OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        for c in [&main, &raw] {
            assert_eq!(pragma(c, "trusted_schema"), rusqlite::types::Value::Integer(0));
            c.execute_batch("PRAGMA writable_schema = ON").unwrap();
            let err = c
                .execute("UPDATE sqlite_master SET sql = sql WHERE name = 'rooms'", [])
                .unwrap_err();
            assert!(err.to_string().contains("table sqlite_master may not be modified"), "{err}");
        }
    }

    // L9: deleted titles and reports do not linger in free pages or the WAL, and the WAL cannot stay large.
    #[test]
    fn deleted_content_is_overwritten_and_the_journal_is_capped() {
        let (_d, path) = tmp();
        let c = open_database(&path).unwrap();
        assert_eq!(pragma(&c, "secure_delete"), rusqlite::types::Value::Integer(2), "FAST");
        let rusqlite::types::Value::Integer(limit) = pragma(&c, "journal_size_limit") else {
            panic!()
        };
        assert!(limit > 0, "{limit}");
    }

    // L7: one open path for every connection: a relative `file:` path is a file name, never a URI.
    #[test]
    fn open_raw_takes_a_file_prefixed_relative_path_as_a_file_name() {
        let name = format!("file:omega-raw-test-{}?mode=memory", std::process::id());
        let c = open_raw(Path::new(&name), OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE).unwrap();
        c.execute_batch("CREATE TABLE t (a)").unwrap();
        drop(c);
        let exists = std::fs::metadata(&name).is_ok_and(|m| m.len() > 0);
        let _ = std::fs::remove_file(&name);
        assert!(exists, "the literal file was not created: the path was read as a URI");
    }

    // Bun's `new Database(path)` has no URI handling: a `file:` path is a file name, never a URI.
    #[test]
    fn a_file_prefixed_path_is_a_literal_file_name() {
        let name = format!("file:omega-uri-test-{}?mode=memory", std::process::id());
        let c = open_database(&name).unwrap();
        c.execute("INSERT INTO takedowns (room_id, at) VALUES ('a', 1)", []).unwrap();
        checkpoint(&c).unwrap();
        drop(c);
        let exists = std::fs::metadata(&name).is_ok_and(|m| m.len() > 0);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{name}{suffix}"));
        }
        assert!(exists, "the literal file was not created: the path was read as a URI");
    }
}
