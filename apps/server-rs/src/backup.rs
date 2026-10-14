//! `omega-server backup snapshot | verify <file> | restore <file> | prune` (port of `apps/server/scripts/backup.ts`,
//! runbook docs/ops/backup.md).
//!
//! A snapshot is SQLite's online backup API: one read transaction, so the server keeps writing while it runs.
//! Nothing here follows a symlink found inside the backup directory: files are created exclusively (0600) and
//! replaced by rename, and `prune` unlinks what it finds.

use crate::cli::time;
use crate::config::Env;
use crate::store::RoomStore;
use crate::store::db::{latest_migration, open_raw};
use rusqlite::OpenFlags;
use rusqlite::backup::{Backup, StepResult};
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

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

/// A snapshot temp file untouched this long was left by a killed run (a live backup keeps writing to its own).
const STALE_TMP_MS: i64 = 60 * 60 * 1000;
const MAGIC: &[u8; 16] = b"SQLite format 3\0";

fn ioerr(e: io::Error) -> String {
    e.to_string()
}

fn sqlerr(e: rusqlite::Error) -> String {
    e.to_string()
}

fn fsync_path(path: &Path) -> Result<(), String> {
    File::open(path).and_then(|f| f.sync_all()).map_err(ioerr)
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(ioerr(e)),
        _ => Ok(()),
    }
}

/// `dirname`: `.` for a bare file name.
fn dir_of(path: &Path) -> PathBuf {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

/// The directory exists and is 0700 (not chmod-ed through a symlink: a linked backup dir is the operator's choice,
/// its target's mode is theirs).
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(ioerr)?;
    let linked = fs::symlink_metadata(dir).map_err(ioerr)?.file_type().is_symlink();
    if !linked {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(ioerr)?;
    }
    if fs::metadata(dir).map_err(ioerr)?.is_dir() {
        Ok(())
    } else {
        Err(format!("{} is not a directory", dir.display()))
    }
}

fn has_magic(path: &Path) -> Result<bool, String> {
    let mut head = [0u8; 16];
    let mut file = File::open(path).map_err(ioerr)?;
    Ok(file.read_exact(&mut head).is_ok() && &head == MAGIC)
}

/// Checks a private copy in place: SQLite header, `PRAGMA integrity_check`, foreign keys, a schema version this
/// code knows, and every room row through the server's own parse (D4). Leaves the file out of WAL mode: a snapshot
/// is one self-contained file. Returns the room count; the error says why not.
fn check(path: &Path) -> Result<usize, String> {
    if !fs::metadata(path).map_err(ioerr)?.is_file() {
        return Err("not a file".to_owned());
    }
    if !has_magic(path)? {
        return Err("not an SQLite database".to_owned());
    }
    let conn = open_raw(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| format!("cannot open: {e}"))?;
    let integrity: Vec<String> = conn
        .prepare("PRAGMA integrity_check")
        .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0))?.collect())
        .map_err(sqlerr)?;
    let problems: Vec<&str> = integrity.iter().map(String::as_str).filter(|m| *m != "ok").collect();
    if !problems.is_empty() || integrity.is_empty() {
        return Err(format!(
            "integrity_check: {}",
            problems.iter().take(3).copied().collect::<Vec<_>>().join("; ")
        ));
    }
    if conn
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut s| s.exists([]))
        .map_err(sqlerr)?
    {
        return Err("foreign_key_check failed".to_owned());
    }
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(sqlerr)?;
    let latest = latest_migration();
    if version < 1 || usize::try_from(version).map_or(true, |v| v > latest) {
        return Err(format!("schema version {version}, this server knows 1\u{2013}{latest}"));
    }
    conn.query_row("PRAGMA journal_mode = DELETE", [], |_| Ok(())).map_err(sqlerr)?;
    RoomStore::new(&conn)
        .list_rooms()
        .map(|rooms| rooms.len())
        .map_err(|e| e.to_string())
}

/// A new private scratch directory under the system temp dir.
fn scratch_dir() -> Result<PathBuf, String> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|_| "no entropy".to_owned())?;
    let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("omega-verify-{name}"));
    fs::DirBuilder::new().mode(0o700).create(&dir).map_err(ioerr)?;
    Ok(dir)
}

/// Copies `from` to a new file `to` (exclusively created, 0600), never into an existing path or through a link.
fn copy_new(from: &Path, to: &Path) -> Result<(), String> {
    let mut src = File::open(from).map_err(ioerr)?;
    let mut dst = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(to)
        .map_err(ioerr)?;
    io::copy(&mut src, &mut dst).map_err(ioerr)?;
    dst.sync_all().map_err(ioerr)
}

/// Verifies a snapshot without writing to it (the check runs on a throwaway copy); its room count.
pub fn verify_snapshot(path: &Path) -> Result<usize, String> {
    let scratch = scratch_dir()?;
    let checked = copy_new(path, &scratch.join("snapshot.db")).and_then(|()| check(&scratch.join("snapshot.db")));
    let _ = fs::remove_dir_all(&scratch);
    checked.map_err(|e| format!("refusing {}: {e}", path.display()))
}

/// `omega-YYYY-MM-DD.db`.
fn is_snapshot(name: &str) -> bool {
    let b = name.as_bytes();
    let digits = |from: usize, to: usize| b.get(from..to).is_some_and(|d| d.iter().all(u8::is_ascii_digit));
    name.len() == 19
        && name.starts_with("omega-")
        && digits(6, 10)
        && b.get(10) == Some(&b'-')
        && digits(11, 13)
        && b.get(13) == Some(&b'-')
        && digits(14, 16)
        && name.ends_with(".db")
}

/// `.omega-YYYY-MM-DD.db.tmp`.
fn is_snapshot_tmp(name: &str) -> bool {
    name.strip_prefix('.').and_then(|n| n.strip_suffix(".tmp")).is_some_and(is_snapshot)
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = fs::symlink_metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    })
}

/// Removes all but the newest `keep` `omega-<date>.db` files in `dir`, and any `.omega-<date>.db.tmp` a killed
/// snapshot left behind (untouched for an hour before `now_ms`); returns what it removed. An entry is unlinked, never
/// followed: a symlink goes, its target stays; a directory is left alone.
pub fn prune(dir: &Path, keep: usize, now_ms: i64) -> Result<Vec<PathBuf>, String> {
    let names: Vec<String> = fs::read_dir(dir)
        .map_err(ioerr)?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    let mut dated: Vec<&String> = names.iter().filter(|n| is_snapshot(n)).collect();
    dated.sort();
    dated.reverse();
    let cutoff = now_ms.saturating_sub(STALE_TMP_MS);
    let stale = names
        .iter()
        .filter(|n| is_snapshot_tmp(n))
        .filter(|n| modified_ms(&dir.join(n)).is_some_and(|m| m < cutoff));
    let mut removed = Vec::new();
    for name in dated.into_iter().skip(keep).chain(stale) {
        let path = dir.join(name);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        remove_if_exists(&path)?;
        removed.push(path);
    }
    Ok(removed)
}

/// Copies `db_path` into `tmp` with SQLite's backup API (one read transaction, the server keeps writing), checks it
/// and renames it to `final_path`.
fn build(db_path: &Path, tmp: &Path, final_path: &Path) -> Result<(), String> {
    {
        let src = open_raw(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(sqlerr)?;
        src.busy_timeout(Duration::from_millis(5000)).map_err(sqlerr)?;
        let mut dst = open_raw(tmp, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(sqlerr)?;
        // -1 pages per step: the whole copy in one step, one consistent point in time.
        let backup = Backup::new(&src, &mut dst).map_err(sqlerr)?;
        // A source locked by a writer is retried for up to 30 s, as the busy timeout would.
        let mut tries = 0;
        loop {
            match backup.step(-1).map_err(sqlerr)? {
                StepResult::Done => break,
                StepResult::More => {}
                _ if tries >= 600 => return Err(format!("{} is busy", db_path.display())),
                _ => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    check(tmp).map_err(|e| format!("snapshot of {} failed its own check: {e}", db_path.display()))?;
    fs::set_permissions(tmp, fs::Permissions::from_mode(0o600)).map_err(ioerr)?;
    fsync_path(tmp)?;
    fs::rename(tmp, final_path).map_err(ioerr)
}

/// Online-backs-up `db_path` into a hidden temp file (0600 from birth), verifies it, renames it to
/// `omega-<UTC date>.db` (replacing that day's) and prunes to `KEEP`. Returns the snapshot's path.
pub fn snapshot(db_path: &Path, dir: &Path, now_ms: i64) -> Result<PathBuf, String> {
    ensure_private_dir(dir)?;
    let name = snapshot_name(now_ms);
    let final_path = dir.join(&name);
    let tmp = dir.join(format!(".{name}.tmp"));
    // A planted link at the temp name is unlinked, not written through; the exclusive create below never follows one.
    remove_if_exists(&tmp)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(ioerr)?;
    let built = build(db_path, &tmp, &final_path);
    // Gone after a good rename; otherwise a full-size copy no later night would reuse.
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(format!("{}{suffix}", tmp.display()));
    }
    built?;
    fsync_path(dir)?;
    prune(dir, KEEP, now_ms)?;
    Ok(final_path)
}

/// Folds `db_path`'s -wal into the main file and empties it. A stopped server (no SIGTERM handler) leaves committed
/// frames there that the main file alone doesn't have. Fails when another connection holds the DB, i.e. the server
/// is still running.
fn checkpoint(db_path: &Path) -> Result<(), String> {
    let conn = open_raw(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(sqlerr)?;
    conn.busy_timeout(Duration::ZERO).map_err(sqlerr)?;
    let busy: i64 = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
        .map_err(sqlerr)?;
    if busy == 0 {
        Ok(())
    } else {
        Err(format!("{} is busy: stop the server first", db_path.display()))
    }
}

/// A hard link where the filesystem allows one (instant, no space), else a full copy.
fn keep_aside(from: &Path, to: &Path) -> Result<(), String> {
    if fs::hard_link(from, to).is_ok() {
        return Ok(());
    }
    copy_new(from, to)
}

/// `20261008T033000Z`.
fn stamp(now_ms: i64) -> String {
    let iso = time(Some(now_ms)).unwrap_or_default().replace(['-', ':'], "");
    match iso.split_once('.') {
        Some((head, _)) => format!("{head}Z"),
        None => iso,
    }
}

/// Replaces `db_path` with a verified copy of `snapshot_path`. The server must be stopped. Nothing at `db_path`
/// changes unless the snapshot passes; the old DB (its -wal checkpointed in) is kept aside as
/// `<db>.pre-restore-<stamp>`, so a restore can be undone, and `db_path` is never missing midway. A stale
/// -wal/-shm never meets the new file.
pub fn restore(snapshot_path: &Path, db_path: &Path, now_ms: i64) -> Result<Restored, String> {
    let dir = dir_of(db_path);
    // Created 0700 if missing, never chmod-ed if it exists: it may be shared with other readers (backup.ts restore).
    fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(ioerr)?;
    let base = db_path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let tmp = dir.join(format!(".{base}.restore-tmp"));
    let tmp_files = [
        tmp.clone(),
        PathBuf::from(format!("{}-journal", tmp.display())),
        PathBuf::from(format!("{}-wal", tmp.display())),
        PathBuf::from(format!("{}-shm", tmp.display())),
    ];
    for f in &tmp_files {
        remove_if_exists(f)?;
    }
    let staged = copy_new(snapshot_path, &tmp).and_then(|()| {
        let rooms = check(&tmp)?;
        fsync_path(&tmp)?;
        Ok(rooms)
    });
    let rooms = match staged {
        Ok(rooms) => rooms,
        Err(err) => {
            for f in &tmp_files {
                let _ = fs::remove_file(f);
            }
            return Err(format!("refusing to restore {}: {err}", snapshot_path.display()));
        }
    };

    // The old DB, its WAL folded in first, is linked (or copied) aside, never moved: DB_PATH exists whole at every
    // instant, and the rename below replaces it atomically. A death before it leaves the old DB in place.
    let mut previous = None;
    if fs::symlink_metadata(db_path).is_ok() {
        if let Err(err) = checkpoint(db_path) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("refusing to restore over {}: {err}", db_path.display()));
        }
        let aside = PathBuf::from(format!("{}.pre-restore-{}", db_path.display(), stamp(now_ms)));
        keep_aside(db_path, &aside)?;
        fsync_path(&dir)?;
        previous = Some(aside);
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        remove_if_exists(Path::new(&format!("{}{suffix}", db_path.display())))?;
    }
    fs::rename(&tmp, db_path).map_err(ioerr)?;
    fsync_path(&dir)?;
    Ok(Restored { rooms, previous })
}

/// L6: refuses while a server answers on the admin socket (`ADMIN_SOCKET`, else beside the DB, as the server
/// binds it): swapping the file under a live server would lose its writes. A flock would need `unsafe`/libc, and
/// the socket is bound only while the server runs (a crash leaves a stale file that nothing answers on).
/// `ADMIN_SOCKET=off` has no socket to ask: the checkpoint in `restore` (busy while the server holds the DB) still guards it.
fn refuse_if_serving(env: &Env, db_path: &Path) -> Result<(), String> {
    let socket = match env.get("ADMIN_SOCKET").map(String::as_str) {
        Some("off") => return Ok(()),
        Some(raw) if !raw.is_empty() => PathBuf::from(raw),
        _ => dir_of(db_path).join("admin.sock"),
    };
    match std::os::unix::net::UnixStream::connect(&socket) {
        Ok(_) => Err(format!(
            "refusing to restore: a server is running (it answers on {}): stop the server first",
            socket.display()
        )),
        Err(_) => Ok(()),
    }
}

const USAGE: &str = "usage: omega-server backup snapshot | verify <file> | restore <file> | prune   (env: DB_PATH, BACKUP_DIR)";

/// The usage line (`backup.ts` becomes `omega-server backup`: the one deliberate difference in the text).
pub fn usage() -> &'static str {
    USAGE
}

/// The `backup` subcommand: the arguments after `backup`, `DB_PATH` and `BACKUP_DIR` from `env`; returns the exit
/// code (0 done, 1 failed, 2 usage).
pub fn run_backup(args: &[String], env: &Env, now_ms: i64, out: &mut dyn FnMut(&str), err: &mut dyn FnMut(&str)) -> i32 {
    let cmd = args.first().map(String::as_str);
    let file = args.get(1);
    let rest = args.get(2..).unwrap_or_default();
    let db_path = env.get("DB_PATH").map_or("", String::as_str);
    let backup_dir = env.get("BACKUP_DIR").map_or(DEFAULT_BACKUP_DIR, String::as_str);
    let needs_db = matches!(cmd, Some("snapshot" | "restore"));
    let needs_file = matches!(cmd, Some("verify" | "restore"));
    let known = needs_db || needs_file || cmd == Some("prune");
    if !known || !rest.is_empty() || needs_file != file.is_some() || (needs_db && (db_path.is_empty() || db_path == ":memory:")) {
        err(usage());
        return 2;
    }
    let done: Result<(), String> = (|| {
        match (cmd, file) {
            (Some("snapshot"), _) => out(&format!(
                "snapshot {}",
                snapshot(Path::new(db_path), Path::new(backup_dir), now_ms)?.display()
            )),
            (Some("prune"), _) => {
                for f in prune(Path::new(backup_dir), KEEP, now_ms)? {
                    out(&format!("pruned {}", f.display()));
                }
            }
            (Some("verify"), Some(file)) => out(&format!("ok {file}: {} rooms", verify_snapshot(Path::new(file))?)),
            (Some("restore"), Some(file)) => {
                refuse_if_serving(env, Path::new(db_path))?;
                let done = restore(Path::new(file), Path::new(db_path), now_ms)?;
                out(&format!("restored {file} \u{2192} {db_path}: {} rooms", done.rooms));
                if let Some(previous) = done.previous {
                    out(&format!("previous database kept at {}", previous.display()));
                }
            }
            _ => {}
        }
        Ok(())
    })();
    match done {
        Ok(()) => 0,
        Err(message) => {
            err(&message);
            1
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::unreachable, reason = "tests")]
mod tests {
    use super::*;
    use crate::contract::layout::default_layout;
    use crate::store::RoomStore;
    use crate::store::{NewRoom, open_database};
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
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
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
            store
                .create_room(&NewRoom::seed(rid(&format!("seed-{i}")), None, 3, default_layout()))
                .unwrap();
        }
        conn.execute_batch("COMMIT").unwrap();
        conn.query_row("PRAGMA journal_mode = DELETE", [], |_| Ok(())).unwrap();
    }

    /// Room ids without migrating or switching the file's journal mode.
    fn rooms(path: &Path) -> Vec<String> {
        let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        RoomStore::new(&conn)
            .list_rooms()
            .unwrap()
            .into_iter()
            .map(|r| r.id.as_str().to_owned())
            .collect()
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
        RoomStore::new(&conn)
            .create_room(&NewRoom::seed(rid("late"), None, 9, default_layout()))
            .unwrap();
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
        seed(&live, 1000);
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
                        store
                            .create_room(&NewRoom::seed(rid(&format!("w-{i}{suffix}")), None, 5, default_layout()))
                            .unwrap();
                    }
                    conn.execute_batch("COMMIT").unwrap();
                    if i == 0 {
                        ready.send(()).unwrap();
                    }
                    i += 1;
                    std::thread::sleep(Duration::from_millis(25));
                }
            })
        };
        started.recv().unwrap();
        let out = t.path().join("backups");
        let mut counts = Vec::new();
        for d in 1..=5 {
            let path = snapshot(&live, &out, day(d)).unwrap();
            assert!(verify_snapshot(&path).unwrap() > 1000);
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
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
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
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let fresh = SystemTime::UNIX_EPOCH + Duration::from_millis(u64::try_from(now - 1000).unwrap());
        std::fs::File::options()
            .write(true)
            .open(out.join(".omega-2026-09-02.db.tmp"))
            .unwrap()
            .set_modified(fresh)
            .unwrap();
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
                conn.execute("UPDATE rooms SET layout = ? WHERE id = 'den'", [r#"{"furniture":[]}"#])
                    .unwrap();
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
        for kind in [
            "not a database",
            "truncated",
            "a damaged page",
            "a forged layout",
            "an empty database",
        ] {
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
        RoomStore::new(&open)
            .create_room(&NewRoom::seed(rid("beta"), None, 9, default_layout()))
            .unwrap();
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
        RoomStore::new(&server)
            .create_room(&NewRoom::seed(rid("beta"), None, 9, default_layout()))
            .unwrap();
        server.execute_batch("BEGIN").unwrap();
        server.query_row("SELECT count(*) FROM rooms", [], |_| Ok(())).unwrap();
        let err = restore(&snap, &live, NIGHT).unwrap_err();
        assert!(err.contains("busy"), "{err}");
        server.execute_batch("COMMIT").unwrap();
        let leftovers: Vec<String> = sorted_names(live.parent().unwrap())
            .into_iter()
            .filter(|f| f.contains("pre-restore") || f.contains("restore-tmp"))
            .collect();
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

    // L6: a running server answers on its admin socket; restore must not swap the file under it.
    #[test]
    fn restore_through_the_cli_refuses_while_the_admin_socket_answers() {
        let t = tempfile::tempdir().unwrap();
        let live = t.path().join("live/omega.db");
        seed(&live, 0);
        let snap = snapshot(&live, &t.path().join("backups"), NIGHT).unwrap();
        let sock = t.path().join("live/admin.sock");
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let before = std::fs::read(&live).unwrap();
        let env: Env = [("DB_PATH".to_owned(), live.display().to_string())].into();
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_backup(
            &args(&["restore", snap.to_str().unwrap()]),
            &env,
            NIGHT,
            &mut |l| out.push(l.to_owned()),
            &mut |l| err.push(l.to_owned()),
        );
        assert_eq!((code, out.len()), (1, 0), "{err:?}");
        assert!(err[0].contains("running") && err[0].contains("stop the server"), "{err:?}");
        assert_eq!(std::fs::read(&live).unwrap(), before, "nothing changed");
        drop(listener);
        // A stale socket file (nothing listens) does not block a restore of a stopped server.
        let env_off: Env = [("DB_PATH".to_owned(), live.display().to_string())].into();
        let code = run_backup(
            &args(&["restore", snap.to_str().unwrap()]),
            &env_off,
            NIGHT,
            &mut |_| {},
            &mut |l| err.push(l.to_owned()),
        );
        assert_eq!(code, 0, "{err:?}");
    }

    // apps/server/test/backup.test.ts:311
    #[test]
    fn the_cli_needs_db_path_and_a_known_command() {
        let run = |parts: &[&str], env: &[(&str, &str)]| {
            let env: Env = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = run_backup(&args(parts), &env, NIGHT, &mut |l| out.push(l.to_owned()), &mut |l| {
                err.push(l.to_owned())
            });
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
        assert_eq!(
            usage(),
            "usage: omega-server backup snapshot | verify <file> | restore <file> | prune   (env: DB_PATH, BACKUP_DIR)"
        );
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
            let code = run_backup(&args(parts), &env, NIGHT, &mut |l| out.push(l.to_owned()), &mut |l| {
                err.push(l.to_owned())
            });
            (code, out, err)
        };
        let snap = backups.join("omega-2026-10-08.db");
        assert_eq!(run(&["snapshot"]), (0, vec![format!("snapshot {}", snap.display())], vec![]));
        assert_eq!(
            run(&["verify", snap.to_str().unwrap()]),
            (0, vec![format!("ok {}: 2 rooms", snap.display())], vec![])
        );
        let (code, out, _) = run(&["restore", snap.to_str().unwrap()]);
        assert_eq!(code, 0);
        assert!(
            out[0].starts_with(&format!("restored {} \u{2192} {}: 2 rooms", snap.display(), live.display())),
            "{out:?}"
        );
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

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod restore_dir_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    // apps/server/scripts/backup.ts:restore: `mkdirSync(dir, { recursive: true, mode: 0o700 })`, never a chmod of an existing dir
    #[test]
    fn restore_leaves_the_mode_of_an_existing_db_directory_alone() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("src/omega.db");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        drop(crate::store::open_database(src.to_str().unwrap()).unwrap());
        let snap = snapshot(&src, &t.path().join("backups"), 1_791_430_200_000).unwrap();
        let live_dir = t.path().join("live");
        std::fs::create_dir(&live_dir).unwrap();
        std::fs::set_permissions(&live_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        restore(&snap, &live_dir.join("omega.db"), 1_791_430_200_000).unwrap();
        assert_eq!(std::fs::metadata(&live_dir).unwrap().permissions().mode() & 0o777, 0o755);
    }
}
