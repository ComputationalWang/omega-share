//! `omega-server backup snapshot | verify <file> | restore <file> | prune` (port of `apps/server/scripts/backup.ts`,
//! runbook docs/ops/backup.md).
//!
//! A snapshot is SQLite's online backup API: one read transaction, so the server keeps writing while it runs.
//! Nothing here follows a symlink found inside the backup directory: files are created exclusively (0600) and
//! replaced by rename, and `prune` unlinks what it finds.

use crate::cli::time;
use crate::config::Env;
use std::path::{Path, PathBuf};

/// Snapshots kept, locally and off-box. Count, not age: a box that was down a month keeps its last 14.
pub const KEEP: usize = 14;
pub const DEFAULT_BACKUP_DIR: &str = "/var/backups/omega-share";

/// `omega-YYYY-MM-DD.db`, the UTC date of the Unix-ms instant `now_ms` (`toISOString().slice(0, 10)`).
pub fn snapshot_name(now_ms: i64) -> String {
    let iso = time(Some(now_ms)).unwrap_or_default();
    format!("omega-{}.db", iso.chars().take(10).collect::<String>())
}

/// What `restore` did.
#[derive(Debug, PartialEq, Eq)]
pub struct Restored {
    pub rooms: usize,
    /// Where the replaced database was kept, if there was one.
    pub previous: Option<PathBuf>,
}

/// Verifies a snapshot without writing to it (the check runs on a throwaway copy); its room count.
pub fn verify_snapshot(path: &Path) -> Result<usize, String> {
    let _ = path;
    Err("not implemented".to_owned())
}

/// Removes all but the newest `keep` `omega-<date>.db` files in `dir`, and any `.omega-<date>.db.tmp` a killed
/// snapshot left behind (untouched for an hour before `now_ms`); returns what it removed.
pub fn prune(dir: &Path, keep: usize, now_ms: i64) -> Result<Vec<PathBuf>, String> {
    let _ = (dir, keep, now_ms);
    Err("not implemented".to_owned())
}

/// Online-backs-up `db_path` into a hidden temp file (0600 from birth), verifies it, renames it to
/// `omega-<UTC date>.db` (replacing that day's) and prunes to `KEEP`. Returns the snapshot's path.
pub fn snapshot(db_path: &Path, dir: &Path, now_ms: i64) -> Result<PathBuf, String> {
    let _ = (db_path, dir, now_ms);
    Err("not implemented".to_owned())
}

/// Replaces `db_path` with a verified copy of `snapshot_path`. The server must be stopped. Nothing at `db_path`
/// changes unless the snapshot passes; the old DB (its -wal checkpointed in) is kept aside as
/// `<db>.pre-restore-<stamp>`, and `db_path` is never missing midway.
pub fn restore(snapshot_path: &Path, db_path: &Path, now_ms: i64) -> Result<Restored, String> {
    let _ = (snapshot_path, db_path, now_ms);
    Err("not implemented".to_owned())
}

/// The usage line.
pub fn usage() -> &'static str {
    ""
}

/// The `backup` subcommand: the arguments after `backup`, `DB_PATH` and `BACKUP_DIR` from `env`; returns the exit
/// code (0 done, 1 failed, 2 usage).
pub fn run_backup(args: &[String], env: &Env, now_ms: i64, out: &mut dyn FnMut(&str), err: &mut dyn FnMut(&str)) -> i32 {
    let _ = (args, env, now_ms, out, err);
    99
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::unreachable, reason = "tests")]
mod tests {
    use super::*;
    use crate::contract::layout::default_layout;
    use crate::store::{NewRoom, open_database};
    use crate::store::RoomStore;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    use std::time::{Duration, SystemTime};

    const NIGHT: i64 = 1_791_430_200_000; // 2026-10-08T03:30:00Z
    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 24 * HOUR;

    fn day(n: i64) -> i64 {
        // 2026-09-<n>T03:30Z
        1_788_233_400_000 + (n - 1) * DAY
    }

    fn names(days: &[i64]) -> Vec<String> {
        days.iter().map(|d| format!("omega-2026-09-{d:02}.db")).collect()
    }

    fn rid(id: &str) -> crate::contract::ids::RoomId {
        crate::contract::ids::RoomId::parse(id).unwrap()
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn sorted_names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        v.sort();
        v
    }

    fn sha(path: &Path) -> Vec<u8> {
        Sha256::digest(std::fs::read(path).unwrap()).to_vec()
    }

    /// A live DB with `lobby` and `den` (and `extra` more), left out of WAL mode and closed.
    fn seed(path: &Path, extra: usize) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = open_database(path.to_str().unwrap()).unwrap();
        conn.execute_batch("BEGIN").unwrap();
        let store = RoomStore::new(&conn);
        store.create_room(&NewRoom::seed(rid("lobby"), None, 1, default_layout())).unwrap();
        store.create_room(&NewRoom::seed(rid("den"), None, 2, default_layout())).unwrap();
        for i in 0..extra {
            store.create_room(&NewRoom::seed(rid(&format!("seed-{i}")), None, 3, default_layout())).unwrap();
        }
        conn.execute_batch("COMMIT").unwrap();
        conn.query_row("PRAGMA journal_mode = DELETE", [], |_| Ok(())).unwrap();
    }

    /// Room ids without migrating or switching the file's journal mode.
    fn rooms(path: &Path) -> Vec<String> {
        let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        RoomStore::new(&conn).list_rooms().unwrap().into_iter().map(|r| r.id.as_str().to_owned()).collect()
    }

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|p| (*p).to_owned()).collect()
    }

    // apps/server/test/backup.test.ts:75
    #[test]
    fn a_snapshot_is_omega_date_db_0600_in_a_0700_dir_it_creates_and_it_verifies() {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let out = t.path().join("backups");
        let path = snapshot(&live, &out, NIGHT).unwrap();
        assert_eq!(path, out.join("omega-2026-10-08.db"));
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&out), 0o700);
        assert_eq!(verify_snapshot(&path).unwrap(), 2);
        assert_eq!(rooms(&path), ["lobby", "den"]);
        assert_eq!(sorted_names(&out), ["omega-2026-10-08.db"]);
    }

    // apps/server/test/backup.test.ts:87
    #[test]
    fn a_second_run_the_same_day_replaces_that_days_snapshot() {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let out = t.path().join("backups");
        snapshot(&live, &out, NIGHT).unwrap();
        let conn = open_database(live.to_str().unwrap()).unwrap();
        RoomStore::new(&conn).create_room(&NewRoom::seed(rid("late"), None, 9, default_layout())).unwrap();
        drop(conn);
        let path = snapshot(&live, &out, NIGHT + 20 * HOUR).unwrap();
        assert_eq!(verify_snapshot(&path).unwrap(), 3);
        assert_eq!(sorted_names(&out), ["omega-2026-10-08.db"]);
    }

    // apps/server/test/backup.test.ts:99
    #[test]
    fn a_snapshot_is_consistent_while_another_connection_keeps_writing() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 2000);
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let (ready, started) = mpsc::channel();
        let writer = {
            let (stop, live) = (stop.clone(), live.clone());
            std::thread::spawn(move || {
                let conn = open_database(live.to_str().unwrap()).unwrap();
                let mut i = 0;
                while !stop.load(Ordering::SeqCst) {
                    // A committed pair: a snapshot must never hold half of one.
                    conn.execute_batch("BEGIN").unwrap();
                    let store = RoomStore::new(&conn);
                    for suffix in ["a", "b"] {
                        store.create_room(&NewRoom::seed(rid(&format!("w-{i}{suffix}")), None, 5, default_layout())).unwrap();
                    }
                    conn.execute_batch("COMMIT").unwrap();
                    if i == 0 {
                        ready.send(()).unwrap();
                    }
                    i += 1;
                }
            })
        };
        started.recv().unwrap();
        let out = t.path().join("backups");
        let mut counts = Vec::new();
        for d in 1..=5 {
            let path = snapshot(&live, &out, day(d)).unwrap();
            assert!(verify_snapshot(&path).unwrap() > 2000);
            let w = rooms(&path).iter().filter(|r| r.starts_with("w-")).count();
            assert_eq!(w % 2, 0, "half of a committed pair");
            counts.push(w);
            std::thread::sleep(Duration::from_millis(20));
        }
        stop.store(true, Ordering::SeqCst);
        writer.join().unwrap();
        assert!(counts[0] > 0);
        assert!(counts.windows(2).all(|w| w[1] > w[0]), "{counts:?}");
        assert_eq!(sorted_names(&out), names(&[1, 2, 3, 4, 5]));
    }

    // apps/server/test/backup.test.ts:126
    #[test]
    fn no_temp_file_is_left_when_the_final_rename_fails() {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let out = t.path().join("backups");
        std::fs::create_dir_all(out.join("omega-2026-10-08.db/in-the-way")).unwrap(); // rename onto a full dir fails
        assert!(snapshot(&live, &out, NIGHT).is_err());
        assert_eq!(sorted_names(&out), ["omega-2026-10-08.db"]);
    }

    // apps/server/test/backup.test.ts:134
    #[test]
    fn a_snapshot_sweeps_temp_files_a_killed_run_left_on_an_earlier_night() {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let out = t.path().join("backups");
        std::fs::DirBuilder::new().mode(0o700).create(&out).unwrap();
        let stale = out.join(".omega-2026-10-06.db.tmp");
        std::fs::write(&stale, "x".repeat(4096)).unwrap();
        let old = SystemTime::UNIX_EPOCH + Duration::from_millis(u64::try_from(NIGHT - 2 * DAY).unwrap());
        std::fs::File::options().write(true).open(&stale).unwrap().set_modified(old).unwrap();
        snapshot(&live, &out, NIGHT).unwrap();
        assert_eq!(sorted_names(&out), ["omega-2026-10-08.db"]);
    }

    // apps/server/test/backup.test.ts:146
    #[test]
    fn the_fifteenth_night_prunes_the_oldest() {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let out = t.path().join("backups");
        for d in 1..=15 {
            snapshot(&live, &out, day(d)).unwrap();
        }
        assert_eq!(KEEP, 14);
        assert_eq!(sorted_names(&out), names(&(2..=15).collect::<Vec<_>>()));
    }

    // apps/server/test/backup.test.ts:156
    #[test]
    fn prune_removes_all_but_the_newest_14_and_leaves_other_files_alone() {
        let t = tempfile::tempdir().unwrap();
        let out = t.path();
        for n in names(&(1..=20).collect::<Vec<_>>()) {
            std::fs::write(out.join(n), "x").unwrap();
        }
        std::fs::write(out.join("notes.txt"), "keep me").unwrap();
        std::fs::write(out.join("omega-latest.db"), "not a dated snapshot").unwrap();
        let mut removed = prune(out, KEEP, NIGHT).unwrap();
        removed.sort();
        assert_eq!(removed, names(&[1, 2, 3, 4, 5, 6]).iter().map(|n| out.join(n)).collect::<Vec<_>>());
        let mut want: Vec<String> = names(&(7..=20).collect::<Vec<_>>());
        want.extend(["notes.txt".to_owned(), "omega-latest.db".to_owned()]);
        want.sort();
        assert_eq!(sorted_names(out), want);
    }

    // apps/server/test/backup.test.ts:166
    #[test]
    fn prune_removes_stale_temp_files_but_not_one_still_being_written() {
        let t = tempfile::tempdir().unwrap();
        let out = t.path();
        let stale = out.join(".omega-2026-09-01.db.tmp");
        std::fs::write(&stale, "x").unwrap();
        std::fs::write(out.join(".omega-2026-09-02.db.tmp"), "x").unwrap();
        std::fs::write(out.join(".other.tmp"), "not ours").unwrap();
        let now = NIGHT;
        let old = SystemTime::UNIX_EPOCH + Duration::from_millis(u64::try_from(now - 2 * DAY).unwrap());
        std::fs::File::options().write(true).open(&stale).unwrap().set_modified(old).unwrap();
        let fresh = SystemTime::UNIX_EPOCH + Duration::from_millis(u64::try_from(now - 1000).unwrap());
        std::fs::File::options().write(true).open(out.join(".omega-2026-09-02.db.tmp")).unwrap().set_modified(fresh).unwrap();
        assert_eq!(prune(out, KEEP, now).unwrap(), [stale]);
        assert_eq!(sorted_names(out), [".omega-2026-09-02.db.tmp", ".other.tmp"]);
    }

    // apps/server/test/backup.test.ts:180
    #[test]
    fn with_14_or_fewer_prune_removes_nothing() {
        let t = tempfile::tempdir().unwrap();
        for n in names(&[3, 1, 2]) {
            std::fs::write(t.path().join(n), "x").unwrap();
        }
        assert_eq!(prune(t.path(), KEEP, NIGHT).unwrap(), Vec::<PathBuf>::new());
        assert_eq!(sorted_names(t.path()).len(), 3);
    }

    fn corrupt(kind: &str, snap: &Path) {
        match kind {
            "not a database" => std::fs::write(snap, "this is not an SQLite file at all, just text\n".repeat(200)).unwrap(),
            "truncated" => {
                let len = std::fs::metadata(snap).unwrap().len();
                std::fs::File::options().write(true).open(snap).unwrap().set_len(len / 2).unwrap();
            }
            "a damaged page" => {
                let mut bytes = std::fs::read(snap).unwrap();
                bytes[4096 * 3..4096 * 3 + 2048].fill(0xa5); // the middle of a b-tree page
                std::fs::write(snap, bytes).unwrap();
            }
            "a forged layout" => {
                let conn = rusqlite::Connection::open(snap).unwrap();
                conn.execute("UPDATE rooms SET layout = ? WHERE id = 'den'", [r#"{"furniture":[]}"#]).unwrap();
            }
            "an empty database" => {
                std::fs::remove_file(snap).unwrap();
                drop(rusqlite::Connection::open(snap).unwrap());
            }
            other => unreachable!("{other}"),
        }
    }

    // apps/server/test/backup.test.ts:204
    #[test]
    fn restore_refuses_a_bad_snapshot_and_leaves_db_path_untouched() {
        for kind in ["not a database", "truncated", "a damaged page", "a forged layout", "an empty database"] {
            let t = tempfile::tempdir().unwrap();
            let src = t.path().join("src/omega.db");
            seed(&src, 400);
            let snap = snapshot(&src, &t.path().join("backups"), NIGHT).unwrap();
            corrupt(kind, &snap);
            let live = t.path().join("live/omega.db");
            seed(&live, 0);
            let before = sha(&live);
            let files = sorted_names(live.parent().unwrap());
            assert!(verify_snapshot(&snap).is_err(), "{kind}");
            let err = restore(&snap, &live, NIGHT).unwrap_err();
            assert!(err.contains("refus"), "{kind}: {err}");
            assert_eq!(sha(&live), before, "{kind}");
            assert_eq!(sorted_names(live.parent().unwrap()), files, "{kind}");
        }
    }

    // apps/server/test/backup.test.ts:225
    #[test]
    fn restore_replaces_db_path_0600_ignores_a_stale_wal_and_keeps_the_old_db_aside() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("src/omega.db");
        seed(&src, 0);
        let snap = snapshot(&src, &t.path().join("backups"), NIGHT).unwrap();
        // A crashed server: "beta" exists only in the live DB's WAL.
        let scratch = t.path().join("scratch/omega.db");
        seed(&scratch, 0);
        let open = open_database(scratch.to_str().unwrap()).unwrap();
        RoomStore::new(&open).create_room(&NewRoom::seed(rid("beta"), None, 9, default_layout())).unwrap();
        let live = t.path().join("crashed/omega.db");
        std::fs::DirBuilder::new().mode(0o700).create(live.parent().unwrap()).unwrap();
        std::fs::copy(&scratch, &live).unwrap();
        let wal = PathBuf::from(format!("{}-wal", scratch.display()));
        let live_wal = PathBuf::from(format!("{}-wal", live.display()));
        std::fs::copy(&wal, &live_wal).unwrap();
        drop(open);

        let done = restore(&snap, &live, NIGHT).unwrap();
        assert_eq!(done.rooms, 2);
        assert_eq!(mode(&live), 0o600);
        assert!(!live_wal.exists());
        assert_eq!(rooms(&live), ["lobby", "den"]);
        let previous = done.previous.unwrap();
        assert_eq!(previous, PathBuf::from(format!("{}.pre-restore-20261008T033000Z", live.display())));
        assert_eq!(rooms(&previous), ["lobby", "den", "beta"]);
    }

    // apps/server/test/backup.test.ts:278
    #[test]
    fn restore_refuses_while_another_connection_holds_the_db() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("src/omega.db");
        seed(&src, 0);
        let snap = snapshot(&src, &t.path().join("backups"), NIGHT).unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let server = open_database(live.to_str().unwrap()).unwrap();
        RoomStore::new(&server).create_room(&NewRoom::seed(rid("beta"), None, 9, default_layout())).unwrap();
        server.execute_batch("BEGIN").unwrap();
        server.query_row("SELECT count(*) FROM rooms", [], |_| Ok(())).unwrap();
        let err = restore(&snap, &live, NIGHT).unwrap_err();
        assert!(err.contains("busy"), "{err}");
        server.execute_batch("COMMIT").unwrap();
        let leftovers: Vec<String> = sorted_names(live.parent().unwrap()).into_iter().filter(|f| f.contains("pre-restore") || f.contains("restore-tmp")).collect();
        assert_eq!(leftovers, Vec::<String>::new());
        assert_eq!(rooms(&live), ["lobby", "den", "beta"]);
    }

    // apps/server/test/backup.test.ts:295
    #[test]
    fn restore_into_a_wiped_db_path() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("src/omega.db");
        seed(&src, 0);
        let snap = snapshot(&src, &t.path().join("backups"), NIGHT).unwrap();
        let live = t.path().join("wiped/omega.db");
        let done = restore(&snap, &live, NIGHT).unwrap();
        assert_eq!(done, Restored { rooms: 2, previous: None });
        assert_eq!(mode(&live), 0o600);
        assert_eq!(rooms(&live), ["lobby", "den"]);
    }

    // apps/server/test/backup.test.ts:311
    #[test]
    fn the_cli_needs_db_path_and_a_known_command() {
        let run = |parts: &[&str], env: &[(&str, &str)]| {
            let env: Env = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = run_backup(&args(parts), &env, NIGHT, &mut |l| out.push(l.to_owned()), &mut |l| err.push(l.to_owned()));
            (code, out, err)
        };
        let usage_line = vec![usage().to_owned()];
        assert_eq!(run(&["snapshot"], &[]), (2, vec![], usage_line.clone()));
        assert_eq!(run(&["snapshot"], &[("DB_PATH", ":memory:")]), (2, vec![], usage_line.clone()));
        assert_eq!(run(&["nope"], &[("DB_PATH", "/x.db")]), (2, vec![], usage_line.clone()));
        assert_eq!(run(&["restore"], &[("DB_PATH", "/x.db")]), (2, vec![], usage_line.clone()));
        assert_eq!(run(&["verify"], &[]), (2, vec![], usage_line.clone()));
        assert_eq!(run(&["prune", "extra"], &[]), (2, vec![], usage_line.clone()));
        assert_eq!(run(&["snapshot", "file"], &[("DB_PATH", "/x.db")]), (2, vec![], usage_line));
        assert_eq!(usage(), "usage: omega-server backup snapshot | verify <file> | restore <file> | prune   (env: DB_PATH, BACKUP_DIR)");
    }

    // apps/server/test/backup.test.ts:317, apps/server/scripts/backup.ts:main
    #[test]
    fn the_cli_prints_what_it_did_and_refuses_a_corrupt_snapshot_with_exit_1() {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let backups = t.path().join("backups");
        let env: Env = [
            ("DB_PATH".to_owned(), live.display().to_string()),
            ("BACKUP_DIR".to_owned(), backups.display().to_string()),
        ]
        .into();
        let run = |parts: &[&str]| {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = run_backup(&args(parts), &env, NIGHT, &mut |l| out.push(l.to_owned()), &mut |l| err.push(l.to_owned()));
            (code, out, err)
        };
        let snap = backups.join("omega-2026-10-08.db");
        assert_eq!(run(&["snapshot"]), (0, vec![format!("snapshot {}", snap.display())], vec![]));
        assert_eq!(run(&["verify", snap.to_str().unwrap()]), (0, vec![format!("ok {}: 2 rooms", snap.display())], vec![]));
        let (code, out, _) = run(&["restore", snap.to_str().unwrap()]);
        assert_eq!(code, 0);
        assert!(out[0].starts_with(&format!("restored {} \u{2192} {}: 2 rooms", snap.display(), live.display())), "{out:?}");
        assert!(out[1].starts_with("previous database kept at "), "{out:?}");
        assert_eq!(run(&["prune"]), (0, vec![], vec![]));
        let bad = t.path().join("omega-2026-10-08.db");
        std::fs::write(&bad, "garbage").unwrap();
        let (code, out, err) = run(&["restore", bad.to_str().unwrap()]);
        assert_eq!((code, out), (1, vec![]));
        assert!(err[0].contains("refus"), "{err:?}");
    }

    // Not in TS: nothing inside the backup directory is followed.
    #[test]
    fn a_planted_symlink_in_the_backup_dir_is_replaced_never_written_through() {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let out = t.path().join("backups");
        std::fs::DirBuilder::new().mode(0o700).create(&out).unwrap();
        let victim = t.path().join("victim.txt");
        std::fs::write(&victim, "precious").unwrap();
        std::os::unix::fs::symlink(&victim, out.join(".omega-2026-10-08.db.tmp")).unwrap();
        std::os::unix::fs::symlink(&victim, out.join("omega-2026-10-08.db")).unwrap();
        // An old snapshot that is a link: pruning unlinks the link, not what it points to.
        std::os::unix::fs::symlink(&victim, out.join("omega-2026-01-01.db")).unwrap();
        let path = snapshot(&live, &out, NIGHT).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious");
        assert!(!std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        assert_eq!(verify_snapshot(&path).unwrap(), 2);
        assert_eq!(sorted_names(&out), ["omega-2026-01-01.db", "omega-2026-10-08.db"]);
        let removed = prune(&out, 1, NIGHT).unwrap();
        assert_eq!(removed, [out.join("omega-2026-01-01.db")]);
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious");
    }

    // Not in TS: a backup dir that is itself a link is the operator's choice, but its target's mode is not changed.
    #[test]
    fn a_symlinked_backup_dir_keeps_its_targets_mode() {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let target = t.path().join("elsewhere");
        std::fs::DirBuilder::new().mode(0o755).create(&target).unwrap();
        let link = t.path().join("backups");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let path = snapshot(&live, &link, NIGHT).unwrap();
        assert_eq!(verify_snapshot(&path).unwrap(), 2);
        assert_eq!(mode(&target), 0o755);
        assert!(target.join("omega-2026-10-08.db").exists());
    }
}
