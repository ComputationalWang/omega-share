import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { latestMigration, openDatabase } from "../src/store/db";
import { REPORT_MAX_ROWS, ReportStore, type NewReport } from "../src/store/reports";

/** Migration 0006 and the report store (ADR 0033 §3, §5). */

let db: Database | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

const T0 = Date.UTC(2026, 9, 9);
const ROOM = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
let n = 0;
const reportId = (): string => `r${String(n++).padStart(21, "0")}`;
const report = (over: Partial<NewReport> = {}): NewReport => ({
  id: reportId(),
  roomId: ROOM,
  reason: "spam",
  note: null,
  roomTitle: "Film club",
  embedUrl: null,
  createdAt: T0,
  ...over,
});

function open(): ReportStore {
  db = openDatabase(":memory:");
  return new ReportStore(db);
}

const states = (d: Database): Record<string, number> =>
  Object.fromEntries(d.query<{ state: string; n: number }, []>("SELECT state, count(*) AS n FROM reports GROUP BY state").all().map((r) => [r.state, r.n]));

describe("migration 0006", () => {
  test("is the newest migration", () => {
    expect(latestMigration()).toBe(6);
  });

  test("reports has exactly the ADR 0033 §3 columns: nothing about the reporter", () => {
    open();
    const cols = db?.query<{ name: string }, []>("PRAGMA table_info(reports)").all().map((c) => c.name);
    expect(cols).toEqual(["id", "room_id", "reason", "note", "room_title", "embed_url", "created_at", "state"]);
  });

  test("takedowns is (room_id, at)", () => {
    open();
    const cols = db?.query<{ name: string }, []>("PRAGMA table_info(takedowns)").all().map((c) => c.name);
    expect(cols).toEqual(["room_id", "at"]);
  });
});

describe("ReportStore", () => {
  test("add, then listOpen returns the row as stored, newest first", () => {
    const store = open();
    store.add(report({ id: "a".repeat(22), reason: "hate", note: "slurs in the title", createdAt: T0 }));
    store.add(report({ id: "b".repeat(22), reason: "sexual", embedUrl: "https://www.youtube-nocookie.com/embed/aaaaaaaaaaa", createdAt: T0 + 1 }));
    expect(store.listOpen()).toEqual([
      { id: "b".repeat(22), roomId: ROOM, reason: "sexual", note: null, roomTitle: "Film club", embedUrl: "https://www.youtube-nocookie.com/embed/aaaaaaaaaaa", createdAt: T0 + 1 },
      { id: "a".repeat(22), roomId: ROOM, reason: "hate", note: "slurs in the title", roomTitle: "Film club", embedUrl: null, createdAt: T0 },
    ]);
    expect(store.openCount()).toBe(2);
  });

  test("refuses an invalid report (bad reason, bad id) and stores nothing", () => {
    const store = open();
    expect(() => {
      store.add(report({ reason: "illegal" as never }));
    }).toThrow();
    expect(() => {
      store.add(report({ id: "short" }));
    }).toThrow();
    expect(store.openCount()).toBe(0);
  });

  test("a corrupt row is left out of listOpen, not thrown", () => {
    const store = open();
    store.add(report());
    db?.run("INSERT INTO reports (id, room_id, reason, note, room_title, embed_url, created_at, state) VALUES (?, ?, 'nonsense', NULL, NULL, NULL, 1, 'open')", [
      "z".repeat(22),
      ROOM,
    ]);
    expect(store.listOpen()).toHaveLength(1);
  });

  test("dismiss marks one open report dismissed; false for an unknown or already closed id", () => {
    const store = open();
    const r = report();
    store.add(r);
    expect(store.dismiss(r.id)).toBe(true);
    expect(store.dismiss(r.id)).toBe(false);
    expect(store.dismiss("q".repeat(22))).toBe(false);
    expect(store.openCount()).toBe(0);
    expect(store.listOpen()).toEqual([]);
  });

  test("dismissRoom and actionRoom close only that room's open reports", () => {
    const store = open();
    store.add(report());
    store.add(report());
    store.add(report({ roomId: OTHER }));
    expect(store.dismissRoom(ROOM)).toBe(2);
    expect(store.dismissRoom(ROOM)).toBe(0);
    store.add(report());
    expect(store.actionRoom(ROOM)).toBe(1);
    if (db === null) throw new Error("no db");
    expect(states(db)).toEqual({ open: 1, dismissed: 2, actioned: 1 });
  });

  test("purge deletes every row created before the cutoff, whatever its state", () => {
    const store = open();
    store.add(report({ createdAt: T0 }));
    const closed = report({ createdAt: T0 + 1 });
    store.add(closed);
    store.dismiss(closed.id);
    store.add(report({ createdAt: T0 + 10 }));
    expect(store.purge(T0 + 10)).toBe(2);
    if (db === null) throw new Error("no db");
    expect(states(db)).toEqual({ open: 1 });
  });

  test(`rows stay bounded: past ${String(REPORT_MAX_ROWS)} rows, the oldest closed rows make room`, () => {
    const store = open();
    if (db === null) throw new Error("no db");
    const d = db;
    d.transaction(() => {
      for (let i = 0; i < REPORT_MAX_ROWS; i++) store.add(report({ createdAt: T0 + i }));
    })();
    // Close all but the newest 10.
    d.run("UPDATE reports SET state = 'dismissed' WHERE created_at < ?", [T0 + REPORT_MAX_ROWS - 10]);
    store.add(report({ createdAt: T0 + REPORT_MAX_ROWS }));
    const count = d.query<{ n: number; oldest: number }, []>("SELECT count(*) AS n, min(created_at) AS oldest FROM reports").get();
    expect(count).toEqual({ n: REPORT_MAX_ROWS, oldest: T0 + 1 });
    expect(store.openCount()).toBe(11);
  });

  test("takedowns are kept, and listed back", () => {
    const store = open();
    expect(store.addTakedown(ROOM, T0)).toBe(true);
    expect(store.addTakedown(ROOM, T0 + 5)).toBe(false);
    expect(store.addTakedown(OTHER, T0 + 1)).toBe(true);
    expect(store.takedowns().sort()).toEqual([ROOM, OTHER]);
  });
});
