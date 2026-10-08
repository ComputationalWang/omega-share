/**
 * Nightly SQLite snapshots and restore (research §2.5, runbook `docs/ops/backup.md`).
 *
 *   bun apps/server/scripts/backup.ts snapshot          DB_PATH → $BACKUP_DIR/omega-<UTC date>.db, keeps 14
 *   bun apps/server/scripts/backup.ts verify <file>     integrity check + every room parsed
 *   bun apps/server/scripts/backup.ts restore <file>    verify, then replace DB_PATH (server stopped!)
 *   bun apps/server/scripts/backup.ts prune             keep the newest 14 in $BACKUP_DIR
 *
 * A snapshot is `VACUUM INTO`: one read transaction, so the server keeps writing while it runs.
 */
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { latestMigration } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";

/** Snapshots kept, locally and off-box. Count, not age: a box that was down a month keeps its last 14. */
export const KEEP = 14;
export const DEFAULT_BACKUP_DIR = "/var/backups/omega-share";

const SNAPSHOT_FILE = /^omega-\d{4}-\d{2}-\d{2}\.db$/;
const SNAPSHOT_TMP = /^\.omega-\d{4}-\d{2}-\d{2}\.db\.tmp$/;
/** A snapshot temp file untouched this long was left by a killed run (VACUUM INTO keeps writing to a live one). */
const STALE_TMP_MS = 60 * 60 * 1000;
const MAGIC = "SQLite format 3\0";

/** `omega-YYYY-MM-DD.db`, the UTC date. */
export const snapshotName = (now: Date): string => `omega-${now.toISOString().slice(0, 10)}.db`;

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function hasMagic(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(MAGIC.length);
    return readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.toString("latin1") === MAGIC;
  } finally {
    closeSync(fd);
  }
}

/**
 * Checks a private copy in place: SQLite header, `PRAGMA integrity_check`, foreign keys, a schema
 * version this code knows, and every room row through the server's own parse (D4). Throws why.
 */
function check(path: string): { rooms: number } {
  if (!statSync(path).isFile()) throw new Error("not a file");
  if (!hasMagic(path)) throw new Error("not an SQLite database");
  let db: Database;
  try {
    db = new Database(path, { readwrite: true, create: false, strict: true });
  } catch (err) {
    throw new Error(`cannot open: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    const problems = integrity.map((r) => r.integrity_check).filter((m) => m !== "ok");
    if (problems.length > 0 || integrity.length === 0) throw new Error(`integrity_check: ${problems.slice(0, 3).join("; ")}`);
    if (db.query("PRAGMA foreign_key_check").all().length > 0) throw new Error("foreign_key_check failed");
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    const latest = latestMigration();
    if (version < 1 || version > latest) throw new Error(`schema version ${String(version)}, this server knows 1–${String(latest)}`);
    // A snapshot is one self-contained file: no -wal to carry around.
    db.run("PRAGMA journal_mode = DELETE");
    return { rooms: new RoomStore(db).listRooms().length };
  } catch (err) {
    // "database disk image is malformed" and friends surface here too.
    throw new Error(err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

/** Verifies a snapshot without writing to it (the check runs on a throwaway copy). */
export function verifySnapshot(path: string): { rooms: number } {
  const scratch = mkdtempSync(join(tmpdir(), "omega-verify-"));
  try {
    const copy = join(scratch, "snapshot.db");
    copyFileSync(path, copy);
    return check(copy);
  } catch (err) {
    throw new Error(`refusing ${path}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Removes all but the newest `keep` `omega-<date>.db` files in `dir`, and any `.omega-<date>.db.tmp`
 * a killed snapshot left behind (untouched for an hour); returns what it removed.
 */
export function prune(dir: string, keep: number = KEEP): string[] {
  const files = readdirSync(dir);
  const old = files
    .filter((f) => SNAPSHOT_FILE.test(f))
    .sort()
    .reverse()
    .slice(keep)
    .map((f) => join(dir, f));
  const cutoff = Date.now() - STALE_TMP_MS;
  const stale = files
    .filter((f) => SNAPSHOT_TMP.test(f))
    .map((f) => join(dir, f))
    .filter((f) => (statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? Infinity) < cutoff);
  for (const f of [...old, ...stale]) rmSync(f, { force: true });
  return [...old, ...stale];
}

/**
 * `VACUUM INTO` a hidden temp file (0600 from birth), verify it, then rename it to
 * `omega-<UTC date>.db` (replacing that day's) and prune to `KEEP`. Returns the snapshot's path.
 */
export function snapshot(dbPath: string, dir: string, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const final = join(dir, snapshotName(now));
  const tmp = join(dir, `.${snapshotName(now)}.tmp`);
  rmSync(tmp, { force: true });
  closeSync(openSync(tmp, "wx", 0o600)); // VACUUM INTO accepts an empty file and keeps its mode
  try {
    const src = new Database(dbPath, { readwrite: true, create: false, strict: true });
    try {
      src.run("PRAGMA busy_timeout = 5000");
      src.run("VACUUM INTO ?", [tmp]);
    } finally {
      src.close();
    }
    try {
      check(tmp);
    } catch (err) {
      throw new Error(`snapshot of ${dbPath} failed its own check: ${err instanceof Error ? err.message : String(err)}`);
    }
    chmodSync(tmp, 0o600);
    fsyncPath(tmp);
    renameSync(tmp, final);
  } finally {
    // Gone after a good rename; otherwise a full-size copy no later night would reuse.
    rmSync(tmp, { force: true });
  }
  fsyncPath(dir);
  prune(dir);
  return final;
}

/**
 * Folds `dbPath`'s -wal into the main file and empties it. A stopped server (no SIGTERM handler)
 * leaves committed frames there that the main file alone doesn't have. Throws when another
 * connection holds the DB, i.e. the server is still running.
 */
function checkpoint(dbPath: string): void {
  const db = new Database(dbPath, { readwrite: true, create: false, strict: true });
  try {
    const r = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (r?.busy !== 0) throw new Error(`${dbPath} is busy: stop the server first`);
  } finally {
    db.close();
  }
}

/** A hard link where the filesystem allows one (instant, no space), else a full copy. */
function keepAside(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
    fsyncPath(to);
  }
}

const stamp = (now: Date): string => now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * Replaces `dbPath` with a verified copy of `snapshotPath`. The server must be stopped. Nothing at
 * `dbPath` changes unless the snapshot passes; the old DB (its -wal checkpointed in) is kept aside as
 * `<db>.pre-restore-<stamp>`, so a restore can be undone, and `dbPath` is never missing midway. A stale -wal/-shm never meets the new file.
 */
export function restore(snapshotPath: string, dbPath: string, now: Date = new Date()): { rooms: number; previous: string | null } {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(dbPath)}.restore-tmp`);
  rmSync(tmp, { force: true });
  let rooms: number;
  try {
    copyFileSync(snapshotPath, tmp);
    chmodSync(tmp, 0o600);
    rooms = check(tmp).rooms;
    fsyncPath(tmp);
  } catch (err) {
    for (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
    throw new Error(`refusing to restore ${snapshotPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The old DB, its WAL folded in first, is linked (or copied) aside, never moved: DB_PATH exists
  // whole at every instant, and the rename below replaces it atomically. A death before it leaves
  // the old DB in place.
  let previous: string | null = null;
  if (existsSync(dbPath)) {
    try {
      checkpoint(dbPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new Error(`refusing to restore over ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    previous = `${dbPath}.pre-restore-${stamp(now)}`;
    keepAside(dbPath, previous);
    fsyncPath(dir);
  }
  for (const f of [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) rmSync(f, { force: true });
  renameSync(tmp, dbPath);
  fsyncPath(dir);
  return { rooms, previous };
}

const USAGE = "usage: backup.ts snapshot | verify <file> | restore <file> | prune   (env: DB_PATH, BACKUP_DIR)";

function main(args: string[], env: Readonly<Record<string, string | undefined>>): number {
  const [cmd, file, ...rest] = args;
  const dbPath = env["DB_PATH"] ?? "";
  const backupDir = env["BACKUP_DIR"] ?? DEFAULT_BACKUP_DIR;
  const needsDb = cmd === "snapshot" || cmd === "restore";
  const needsFile = cmd === "verify" || cmd === "restore";
  const known = cmd === "snapshot" || cmd === "prune" || needsFile;
  if (!known || rest.length > 0 || needsFile !== (file !== undefined) || (needsDb && (dbPath === "" || dbPath === ":memory:"))) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (cmd === "snapshot") {
      const path = snapshot(dbPath, backupDir);
      console.log(`snapshot ${path}`);
    } else if (cmd === "prune") {
      for (const f of prune(backupDir)) console.log(`pruned ${f}`);
    } else if (file !== undefined && cmd === "verify") {
      console.log(`ok ${file}: ${String(verifySnapshot(file).rooms)} rooms`);
    } else if (file !== undefined) {
      const r = restore(file, dbPath);
      console.log(`restored ${file} → ${dbPath}: ${String(r.rooms)} rooms`);
      if (r.previous !== null) console.log(`previous database kept at ${r.previous}`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2), process.env));
