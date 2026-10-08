import { Database } from "bun:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** `apps/server/migrations`: forward-only `NNNN-name.sql` files (research §2.3). */
export const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

const MIGRATION_FILE = /^(\d{4})-[a-z0-9-]+\.sql$/;

interface Migration {
  version: number;
  file: string;
  sql: string;
}

/** Numbered 0001, 0002, … with no gap or duplicate, so `user_version` names exactly one file. */
function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir).filter((f) => MIGRATION_FILE.test(f)).sort();
  return files.map((file, i) => {
    const version = Number(file.slice(0, 4));
    if (version !== i + 1) throw new Error(`migration ${file}: expected number ${String(i + 1).padStart(4, "0")}`);
    return { version, file, sql: readFileSync(join(dir, file), "utf8") };
  });
}

/** The schema version this code migrates to: the newest migration's number. */
export function latestMigration(dir: string = MIGRATIONS_DIR): number {
  return loadMigrations(dir).length;
}

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

/** Applies every migration newer than `user_version`, each in its own transaction. */
function migrate(db: Database, dir: string): void {
  const migrations = loadMigrations(dir);
  const current = userVersion(db);
  if (current > migrations.length) {
    throw new Error(`database user_version ${String(current)} is newer than this server knows (${String(migrations.length)}): refusing to start`);
  }
  for (const m of migrations.slice(current)) {
    try {
      db.transaction(() => {
        db.run(m.sql);
        db.run(`PRAGMA user_version = ${String(m.version)}`);
      })();
    } catch (err) {
      throw new Error(`migration ${m.file} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Creates the file (and its directory) owner-only, and tightens an existing file to 0600 (D5). */
function ensurePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
}

/**
 * Opens the process's one database (research §2.1): WAL, synchronous=NORMAL, foreign keys on,
 * 2 s busy timeout, then runs the migrations. Throws if the file is newer than the code.
 */
export function openDatabase(path: string, migrationsDir: string = MIGRATIONS_DIR): Database {
  if (path !== ":memory:") ensurePrivateFile(path);
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 2000");
    migrate(db, migrationsDir);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
