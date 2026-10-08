import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT, type Embed, type RoomLayout } from "@omega/shared";
import { MIGRATIONS_DIR, openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omega-db-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A migrations dir holding exactly these files. */
const migrations = (files: Record<string, string>): string => {
  const dir = tempDir();
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
};

const userVersion = (db: Database): number => {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? -1;
};
const pragma = (db: Database, name: string): unknown => {
  const row = db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
  return row === null ? undefined : Object.values(row)[0];
};

const REAL_MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}-.+\.sql$/.test(f)).sort();

const YOUTUBE: Embed = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" };

describe("openDatabase: settings at open (research §2.1)", () => {
  test("a file database runs in WAL with synchronous=NORMAL, foreign keys on and a 2 s busy timeout", () => {
    const db = openDatabase(join(tempDir(), "omega.db"));
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "synchronous")).toBe(1);
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "busy_timeout")).toBe(2000);
    db.close();
  });

  test("creates the database file with mode 0600 (D5)", () => {
    const path = join(tempDir(), "omega.db");
    openDatabase(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("tightens an existing world-readable database file to 0600", () => {
    const path = join(tempDir(), "omega.db");
    writeFileSync(path, "", { mode: 0o644 });
    openDatabase(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("migrations (research §2.3)", () => {
  test("every migration runs from empty: user_version is the last one and rooms has the §2.2 schema", () => {
    const db = openDatabase(":memory:");
    expect(REAL_MIGRATIONS.length).toBeGreaterThan(0);
    expect(userVersion(db)).toBe(REAL_MIGRATIONS.length);

    const table = db.query<{ strict: number }, []>("SELECT strict FROM pragma_table_list WHERE name = 'rooms'").get();
    expect(table?.strict).toBe(1);
    const cols = db
      .query<{ name: string; type: string; notnull: number; pk: number }, []>("SELECT name, type, \"notnull\", pk FROM pragma_table_info('rooms')")
      .all();
    expect(cols).toEqual([
      { name: "id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "title", type: "TEXT", notnull: 1, pk: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "layout", type: "TEXT", notnull: 1, pk: 0 },
      { name: "embed", type: "TEXT", notnull: 0, pk: 0 },
    ]);
    // STRICT + CHECK: a 33-character id never lands.
    expect(() => db.run("INSERT INTO rooms (id, created_at, layout) VALUES (?, 0, '{}')", ["a".repeat(33)])).toThrow();
    db.close();
  });

  test("a fixture at version N-1 upgrades to N and keeps its rows", () => {
    const dir = migrations({
      "0001-rooms.sql": "CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT;",
      "0002-name.sql": "ALTER TABLE t ADD COLUMN name TEXT NOT NULL DEFAULT 'x';",
    });
    const path = join(tempDir(), "omega.db");
    const fixture = new Database(path);
    fixture.run("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");
    fixture.run("INSERT INTO t (id) VALUES (7)");
    fixture.run("PRAGMA user_version = 1");
    fixture.close();

    const db = openDatabase(path, dir);
    expect(userVersion(db)).toBe(2);
    expect(db.query("SELECT id, name FROM t").all()).toEqual([{ id: 7, name: "x" }]);
    db.close();
  });

  test("the real migrations upgrade a database at N-1 to N", () => {
    const n = REAL_MIGRATIONS.length;
    const dir = migrations(Object.fromEntries(REAL_MIGRATIONS.slice(0, n - 1).map((f) => [f, readFileSync(join(MIGRATIONS_DIR, f), "utf8")])));
    const path = join(tempDir(), "omega.db");
    openDatabase(path, dir).close();

    const db = openDatabase(path);
    expect(userVersion(db)).toBe(n);
    db.close();
  });

  test("refuses to start when the database is newer than the code knows", () => {
    const path = join(tempDir(), "omega.db");
    const future = new Database(path);
    future.run(`PRAGMA user_version = ${String(REAL_MIGRATIONS.length + 1)}`);
    future.close();
    expect(() => openDatabase(path)).toThrow(/newer/);
  });

  test("a failing migration rolls back whole and leaves user_version where it was", () => {
    const dir = migrations({
      "0001-a.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;",
      "0002-b.sql": "CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT; INSERT INTO nope VALUES (1);",
    });
    const path = join(tempDir(), "omega.db");
    expect(() => openDatabase(path, dir)).toThrow(/0002-b\.sql/);
    const db = new Database(path);
    expect(userVersion(db)).toBe(1);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name = 'b'").get()).toBeNull();
    db.close();
  });

  test("refuses a migrations dir with a gap or a duplicate number", () => {
    expect(() => openDatabase(":memory:", migrations({ "0001-a.sql": "SELECT 1;", "0003-c.sql": "SELECT 1;" }))).toThrow(/0003-c\.sql/);
    expect(() => openDatabase(":memory:", migrations({ "0001-a.sql": "SELECT 1;", "0001-b.sql": "SELECT 1;" }))).toThrow(/0001-b\.sql/);
  });
});

describe("RoomStore", () => {
  const store = (): { db: Database; rooms: RoomStore } => {
    const db = openDatabase(":memory:");
    return { db, rooms: new RoomStore(db) };
  };

  test("createRoom then listRooms gives the room back, embed null", () => {
    const { rooms } = store();
    rooms.createRoom({ id: "lobby", title: "Lobby", createdAt: 1_700_000_000_000, layout: DEFAULT_LAYOUT });
    expect(rooms.listRooms()).toEqual([
      {
        id: "lobby",
        title: "Lobby",
        createdAt: 1_700_000_000_000,
        layout: DEFAULT_LAYOUT,
        embed: null,
        // A room made without an owner is a seed: pinned, public, no secrets (ADR 0028 §2).
        visibility: "public",
        pinned: true,
        ownerHash: null,
        inviteHash: null,
        lastActiveAt: null,
      },
    ]);
  });

  test("setLayout and setEmbed write through; setEmbed(null) clears the TV", () => {
    const { rooms } = store();
    rooms.createRoom({ id: "lobby", title: "", createdAt: 1, layout: DEFAULT_LAYOUT });
    const moved: RoomLayout = {
      furniture: DEFAULT_LAYOUT.furniture.map((f) => (f.kind === "plant" ? { ...f, col: 9, row: 9 } : f)),
    };
    rooms.setLayout("lobby", moved);
    rooms.setEmbed("lobby", YOUTUBE);
    expect(rooms.listRooms()[0]).toMatchObject({ layout: moved, embed: YOUTUBE });
    rooms.setEmbed("lobby", null);
    expect(rooms.listRooms()[0]?.embed).toBeNull();
  });

  test("refuses to write an invalid layout, embed or room id", () => {
    const { rooms } = store();
    rooms.createRoom({ id: "lobby", title: "", createdAt: 1, layout: DEFAULT_LAYOUT });
    const noTv: RoomLayout = { furniture: DEFAULT_LAYOUT.furniture.filter((f) => f.kind !== "tv") };
    expect(() => { rooms.setLayout("lobby", noTv); }).toThrow();
    const forged = { ...YOUTUBE, url: "https://evil.example/embed/dQw4w9WgXcQ" };
    expect(() => { rooms.setEmbed("lobby", forged); }).toThrow();
    expect(() => { rooms.createRoom({ id: "Not A Room", title: "", createdAt: 1, layout: DEFAULT_LAYOUT }); }).toThrow();
    expect(rooms.listRooms()[0]).toMatchObject({ layout: DEFAULT_LAYOUT, embed: null });
  });

  test("setLayout or setEmbed on an unknown room throws", () => {
    const { rooms } = store();
    expect(() => { rooms.setLayout("ghost", DEFAULT_LAYOUT); }).toThrow(/ghost/);
    expect(() => { rooms.setEmbed("ghost", YOUTUBE); }).toThrow(/ghost/);
  });

  test("a corrupt layout row fails loudly on read (D4)", () => {
    const { db, rooms } = store();
    rooms.createRoom({ id: "lobby", title: "", createdAt: 1, layout: DEFAULT_LAYOUT });
    db.run("INSERT INTO rooms (id, title, created_at, layout) VALUES ('hacked', '', 2, ?)", [JSON.stringify({ furniture: [] })]);
    expect(() => rooms.listRooms()).toThrow(/hacked/);
  });

  test("a row whose layout is not JSON, or whose embed is forged, fails loudly on read", () => {
    const a = store();
    a.db.run("INSERT INTO rooms (id, title, created_at, layout) VALUES ('broken', '', 1, 'not json')");
    expect(() => a.rooms.listRooms()).toThrow(/broken/);

    const b = store();
    const forged = JSON.stringify({ ...YOUTUBE, url: "https://evil.example/" });
    b.db.run("INSERT INTO rooms (id, title, created_at, layout, embed) VALUES ('forged', '', 1, ?, ?)", [JSON.stringify(DEFAULT_LAYOUT), forged]);
    expect(() => b.rooms.listRooms()).toThrow(/forged/);
  });
});

describe("migration 0002: created rooms (ADR 0028)", () => {
  const HASH_A = new Uint8Array(32).fill(1);
  const HASH_B = new Uint8Array(32).fill(2);

  test("a 0001 database migrates: its rows become pinned public rooms with no owner, no invite and never active", () => {
    const path = join(tempDir(), "omega.db");
    const only0001 = migrations({ [REAL_MIGRATIONS[0] ?? "missing"]: readFileSync(join(MIGRATIONS_DIR, REAL_MIGRATIONS[0] ?? "missing"), "utf8") });
    const old = openDatabase(path, only0001);
    new RoomStore(old).createRoom({ id: "den", title: "Den", createdAt: 5, layout: DEFAULT_LAYOUT });
    expect(userVersion(old)).toBe(1);
    old.close();

    const db = openDatabase(path);
    expect(userVersion(db)).toBe(2);
    expect(new RoomStore(db).listRooms()).toEqual([
      { id: "den", title: "Den", createdAt: 5, layout: DEFAULT_LAYOUT, embed: null, visibility: "public", pinned: true, ownerHash: null, inviteHash: null, lastActiveAt: null },
    ]);
    db.close();
  });

  test("an owned private room round-trips its hashes, unpinned; deleteRoom removes the row and says whether there was one", () => {
    const rooms = new RoomStore(openDatabase(":memory:"));
    rooms.createRoom({
      id: "abcdefghijklmnopqrstuvwxyz",
      title: "Hidden",
      createdAt: 7,
      layout: DEFAULT_LAYOUT,
      visibility: "private",
      pinned: false,
      ownerHash: HASH_A,
      inviteHash: HASH_B,
    });
    expect(rooms.listRooms()).toEqual([
      {
        id: "abcdefghijklmnopqrstuvwxyz",
        title: "Hidden",
        createdAt: 7,
        layout: DEFAULT_LAYOUT,
        embed: null,
        visibility: "private",
        pinned: false,
        ownerHash: HASH_A,
        inviteHash: HASH_B,
        lastActiveAt: null,
      },
    ]);
    expect(rooms.deleteRoom("abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(rooms.deleteRoom("abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(rooms.listRooms()).toEqual([]);
  });

  test("refuses a hash that isn't 32 bytes, a title that fails RoomTitleSchema and an unknown visibility", () => {
    const rooms = new RoomStore(openDatabase(":memory:"));
    const base = { id: "den", title: "Den", createdAt: 1, layout: DEFAULT_LAYOUT };
    expect(() => { rooms.createRoom({ ...base, ownerHash: new Uint8Array(31) }); }).toThrow();
    expect(() => { rooms.createRoom({ ...base, title: "<b>" }); }).toThrow();
    expect(() => { rooms.createRoom({ ...base, visibility: "secret" as "public" }); }).toThrow();
    expect(rooms.listRooms()).toEqual([]);
  });

  test("a row with a bad visibility, pinned flag or hash fails loudly on read (D4); the table CHECKs refuse them too", () => {
    const db = openDatabase(":memory:");
    const layout = JSON.stringify(DEFAULT_LAYOUT);
    expect(() => db.run("INSERT INTO rooms (id, created_at, layout, visibility) VALUES ('a', 1, ?, 'secret')", [layout])).toThrow();
    expect(() => db.run("INSERT INTO rooms (id, created_at, layout, pinned) VALUES ('b', 1, ?, 2)", [layout])).toThrow();
    expect(() => db.run("INSERT INTO rooms (id, created_at, layout, owner_hash) VALUES ('c', 1, ?, x'00')", [layout])).toThrow();
    db.run("INSERT INTO rooms (id, title, created_at, layout) VALUES ('d', '<b>', 1, ?)", [layout]);
    expect(() => new RoomStore(db).listRooms()).toThrow(/"d"/);
  });
});
