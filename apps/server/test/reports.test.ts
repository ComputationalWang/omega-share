import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  DEFAULT_LAYOUT,
  MAX_REPORT_BODY_BYTES,
  REPORT_KEY_BURST,
  REPORT_KEY_REFILL_MS,
  REPORT_MAX_OPEN,
  REPORT_RETENTION_MS,
  REPORT_ROOM_BURST,
  REPORT_ROOM_REFILL_MS,
  ReportResponseSchema,
  canonicalizeEmbed,
} from "@omega/shared";
import { MAX_DEDUP_ENTRIES, ReportDedup, redactNote } from "../src/reports";
import { RoomRegistry } from "../src/rooms";
import { openDatabase } from "../src/store/db";
import { ReportStore } from "../src/store/reports";
import { RoomStore } from "../src/store/rooms";
import { start, type TestServer } from "./helpers";

/** `POST /rooms/:id/report` (ADR 0033 §1–§4): parse, limits, duplicates, what is stored, metrics, retention. */

let t: TestServer | null = null;
let db: Database | null = null;
afterEach(async () => {
  await t?.server.stop(true);
  t = null;
  db?.close();
  db = null;
});

const T0 = Date.UTC(2026, 9, 9);
const ROOM = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER = new Uint8Array(32).fill(7);
const EMBED = canonicalizeEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

interface Fixture {
  t: TestServer;
  db: Database;
  reportStore: ReportStore;
  rooms: RoomRegistry;
  wall: { ms: number };
  mono: { ms: number };
}

function boot(): Fixture {
  const d = openDatabase(":memory:");
  db = d;
  const store = new RoomStore(d);
  const reportStore = new ReportStore(d);
  for (const id of [ROOM, OTHER]) store.createRoom({ id, title: "Film club", createdAt: T0, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
  store.setEmbed(ROOM, EMBED);
  const wall = { ms: T0 };
  const mono = { ms: 1_000_000 };
  const rooms = new RoomRegistry();
  t = start({ store, reportStore, registry: rooms, trustProxy: true, wallNow: () => wall.ms, now: () => mono.ms });
  return { t, db: d, reportStore, rooms, wall, mono };
}

/** From a keyed client (the tunnel's rightmost X-Forwarded-For) unless `ip` is null. */
function report(f: Fixture, roomId: string, body: unknown, ip: string | null = "198.51.100.7", headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (ip !== null) h["x-forwarded-for"] = ip;
  return fetch(`${f.t.http}/rooms/${roomId}/report`, { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function answer(res: Response) {
  return v.parse(ReportResponseSchema, await res.json());
}

const rows = (f: Fixture) => f.db.query<Record<string, unknown>, []>("SELECT * FROM reports ORDER BY created_at, id").all();

describe("a report", () => {
  test("is stored with 202 received: reason, redacted note, the room's title and what was playing", async () => {
    const f = boot();
    f.wall.ms = T0 + 5000;
    const res = await report(f, ROOM, { reason: "hate", note: "host posts slurs, mail me at ada@example.com" });
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await answer(res)).toEqual({ ok: true, status: "received" });
    const [row, ...more] = rows(f);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      room_id: ROOM,
      reason: "hate",
      note: "host posts slurs, mail me at <email>",
      room_title: "Film club",
      embed_url: EMBED?.url,
      created_at: T0 + 5000,
      state: "open",
    });
    expect(String(row?.["id"])).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("without a note, note is null; the answer never carries a report id or count", async () => {
    const f = boot();
    const res = await report(f, OTHER, { reason: "spam" });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, status: "received" });
    expect(rows(f)[0]).toMatchObject({ note: null, embed_url: null });
    expect(text).not.toContain(String(rows(f)[0]?.["id"]));
  });

  test("keeps nothing about the reporter: no address, user agent, referer, origin or cookie", async () => {
    const f = boot();
    await report(f, ROOM, { reason: "other", note: "look" }, "203.0.113.77", {
      "user-agent": "ProbeAgent/9.9",
      referer: "https://reporter.example/page",
      cookie: "who=reporter-cookie",
      origin: "http://localhost:5173",
    });
    const dump = JSON.stringify(rows(f));
    for (const s of ["203.0.113", "ProbeAgent", "reporter.example", "reporter-cookie", "localhost:5173"]) expect(dump).not.toContain(s);
  });

  test("is never logged", async () => {
    const f = boot();
    const err = spyOn(console, "error");
    const log = spyOn(console, "log");
    const warn = spyOn(console, "warn");
    try {
      await report(f, ROOM, { reason: "danger", note: "unlogged-note-text" });
      for (const spy of [err, log, warn]) expect(spy).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("the largest valid body is under 1 KiB and is accepted", async () => {
    const f = boot();
    const body = JSON.stringify({ reason: "violence", note: "€".repeat(300) });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(1024);
    expect((await report(f, ROOM, body)).status).toBe(202);
  });
});

describe("duplicates", () => {
  test("the same key reporting the same room again gets 200 already_reported, and nothing new is stored", async () => {
    const f = boot();
    expect((await report(f, ROOM, { reason: "spam" })).status).toBe(202);
    const again = await report(f, ROOM, { reason: "sexual", note: "second try" });
    expect(again.status).toBe(200);
    expect(await answer(again)).toEqual({ ok: true, status: "already_reported" });
    expect(rows(f).map((r) => [r["reason"], r["note"]])).toEqual([["spam", null]]);
  });

  test("other keys, and other rooms, are not duplicates", async () => {
    const f = boot();
    expect((await report(f, ROOM, { reason: "spam" }, "198.51.100.1")).status).toBe(202);
    expect((await report(f, ROOM, { reason: "spam" }, "198.51.100.2")).status).toBe(202);
    expect((await report(f, OTHER, { reason: "spam" }, "198.51.100.1")).status).toBe(202);
    expect(rows(f)).toHaveLength(3);
  });

  test("with no usable client key there is no duplicate check (proxy:unknown shares one key bucket)", async () => {
    const f = boot();
    // trustProxy with a loopback peer and no X-Forwarded-For: the shared proxy:unknown key.
    for (let i = 0; i < REPORT_KEY_BURST; i++) expect((await report(f, ROOM, { reason: "spam" }, null)).status).toBe(202);
    expect(rows(f)).toHaveLength(REPORT_KEY_BURST);
    expect((await report(f, ROOM, { reason: "spam" }, null)).status).toBe(429);
  });

  test("the duplicate set stays bounded and is dropped with its room", async () => {
    const f = boot();
    await report(f, ROOM, { reason: "spam" }, "198.51.100.1");
    await report(f, OTHER, { reason: "spam" }, "198.51.100.1");
    expect(f.t.server.reports.dedupSize).toBe(2);
    const room = f.rooms.get(ROOM);
    if (room === undefined) throw new Error("no room");
    f.rooms.removeRoom(room);
    expect(f.t.server.reports.dedupSize).toBe(1);
  });
});

describe("ReportDedup", () => {
  test(`holds at most ${String(MAX_DEDUP_ENTRIES)} entries, evicting the oldest`, () => {
    const d = new ReportDedup();
    for (let i = 0; i <= MAX_DEDUP_ENTRIES; i++) d.add(ROOM, `k${String(i)}`, T0 + i);
    expect(d.size).toBe(MAX_DEDUP_ENTRIES);
    expect(d.has(ROOM, "k0")).toBe(false);
    expect(d.has(ROOM, `k${String(MAX_DEDUP_ENTRIES)}`)).toBe(true);
  });

  test("expire drops entries at or before the cutoff; dropRoom drops one room's", () => {
    const d = new ReportDedup();
    d.add(ROOM, "a", T0);
    d.add(OTHER, "a", T0 + 1);
    d.add(ROOM, "b", T0 + 2);
    d.expire(T0);
    expect([d.has(ROOM, "a"), d.has(OTHER, "a"), d.has(ROOM, "b")]).toEqual([false, true, true]);
    d.dropRoom(ROOM);
    expect([d.size, d.has(OTHER, "a")]).toEqual([1, true]);
  });
});

describe("limits", () => {
  test(`per key: ${String(REPORT_KEY_BURST)} at once (duplicates count), then 429 with Retry-After until the refill`, async () => {
    const f = boot();
    expect((await report(f, ROOM, { reason: "spam" })).status).toBe(202);
    for (let i = 1; i < REPORT_KEY_BURST; i++) expect((await report(f, ROOM, { reason: "spam" })).status).toBe(200);
    const limited = await report(f, OTHER, { reason: "spam" });
    expect(limited.status).toBe(429);
    const body = await answer(limited);
    if (body.ok) throw new Error("expected an error");
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    expect(body.error.retryAfterMs).toBeLessThanOrEqual(REPORT_KEY_REFILL_MS);
    expect(Number(limited.headers.get("retry-after"))).toBe(Math.ceil((body.error.retryAfterMs ?? 0) / 1000));
    f.mono.ms += REPORT_KEY_REFILL_MS;
    expect((await report(f, OTHER, { reason: "spam" })).status).toBe(202);
  });

  test(`per room: ${String(REPORT_ROOM_BURST)} across reporters, then 429; other rooms are unaffected`, async () => {
    const f = boot();
    for (let i = 0; i < REPORT_ROOM_BURST; i++) expect((await report(f, ROOM, { reason: "spam" }, `198.51.100.${String(i + 1)}`)).status).toBe(202);
    const limited = await report(f, ROOM, { reason: "spam" }, "198.51.100.200");
    expect(limited.status).toBe(429);
    const body = await answer(limited);
    if (body.ok) throw new Error("expected an error");
    expect(body.error.retryAfterMs).toBeLessThanOrEqual(REPORT_ROOM_REFILL_MS);
    expect((await report(f, OTHER, { reason: "spam" }, "198.51.100.200")).status).toBe(202);
    f.mono.ms += REPORT_ROOM_REFILL_MS;
    expect((await report(f, ROOM, { reason: "spam" }, "198.51.100.201")).status).toBe(202);
  });

  test("a flood of malformed bodies costs the key bucket but never the room's", async () => {
    const f = boot();
    for (let i = 0; i < REPORT_KEY_BURST; i++) expect((await report(f, ROOM, "{nope", "198.51.100.9")).status).toBe(400);
    expect((await report(f, ROOM, { reason: "spam" }, "198.51.100.9")).status).toBe(429);
    for (let i = 0; i < REPORT_ROOM_BURST; i++) expect((await report(f, ROOM, { reason: "spam" }, `203.0.113.${String(i + 1)}`)).status).toBe(202);
  });

  test("reports to unknown rooms never take from a bucket", async () => {
    const f = boot();
    for (let i = 0; i < 10; i++) expect((await report(f, "cccccccccccccccccccccccccc", { reason: "spam" })).status).toBe(404);
    expect((await report(f, ROOM, { reason: "spam" })).status).toBe(202);
  });

  test("loopback (local dev) skips the key bucket and the duplicate check; the room bucket still applies", async () => {
    const d = openDatabase(":memory:");
    db = d;
    const store = new RoomStore(d);
    store.createRoom({ id: ROOM, title: "Film club", createdAt: T0, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
    t = start({ store, reportStore: new ReportStore(d), now: () => 0, wallNow: () => T0 });
    const f: Fixture = { t, db: d, reportStore: new ReportStore(d), rooms: new RoomRegistry(), wall: { ms: T0 }, mono: { ms: 0 } };
    for (let i = 0; i < REPORT_ROOM_BURST; i++) expect((await report(f, ROOM, { reason: "spam" }, null)).status).toBe(202);
    expect((await report(f, ROOM, { reason: "spam" }, null)).status).toBe(429);
  });

  test(`at ${String(REPORT_MAX_OPEN)} open reports: 503 unavailable, nothing stored`, async () => {
    const f = boot();
    f.db.transaction(() => {
      for (let i = 0; i < REPORT_MAX_OPEN; i++) {
        f.reportStore.add({ id: `x${String(i).padStart(21, "0")}`, roomId: OTHER, reason: "spam", note: null, roomTitle: null, embedUrl: null, createdAt: T0 });
      }
    })();
    const res = await report(f, ROOM, { reason: "spam" });
    expect(res.status).toBe(503);
    const body = await answer(res);
    expect(body.ok ? null : body.error.code).toBe("unavailable");
    expect(rows(f).filter((r) => r["room_id"] === ROOM)).toEqual([]);
  });

  test("a store failure is 503 unavailable and leaves no duplicate mark", async () => {
    const f = boot();
    const add = spyOn(f.reportStore, "add").mockImplementation(() => {
      throw new Error("disk full");
    });
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await report(f, ROOM, { reason: "spam" })).status).toBe(503);
    } finally {
      add.mockRestore();
      err.mockRestore();
    }
    expect((await report(f, ROOM, { reason: "spam" })).status).toBe(202);
  });
});

describe("refused bodies", () => {
  const invalid: [string, string][] = [
    ["not JSON", "{reason:"],
    ["an array", "[]"],
    ["an unknown reason", JSON.stringify({ reason: "illegal" })],
    ["an extra key", JSON.stringify({ reason: "spam", nickname: "Ada" })],
    ["a blank note", JSON.stringify({ reason: "spam", note: "   " })],
    ["a note over 300", JSON.stringify({ reason: "spam", note: "a".repeat(301) })],
    ["a bidi override", JSON.stringify({ reason: "spam", note: "abc‮def" })],
    ["no reason", JSON.stringify({ note: "hi" })],
  ];
  for (const [what, body] of invalid) {
    test(`${what}: 400 invalid_body, nothing stored`, async () => {
      const f = boot();
      const res = await report(f, ROOM, body);
      expect(res.status).toBe(400);
      const parsed = await answer(res);
      expect(parsed.ok ? null : parsed.error.code).toBe("invalid_body");
      expect(rows(f)).toEqual([]);
    });
  }

  test(`over ${String(MAX_REPORT_BODY_BYTES)} bytes: 413 payload_too_large, by Content-Length or by the stream`, async () => {
    const f = boot();
    const big = JSON.stringify({ reason: "spam", note: "a".repeat(MAX_REPORT_BODY_BYTES) });
    const byLength = await report(f, ROOM, big);
    expect(byLength.status).toBe(413);
    expect((await answer(byLength)).ok).toBe(false);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const chunked = await fetch(`${f.t.http}/rooms/${ROOM}/report`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.3" }, body: stream });
    expect(chunked.status).toBe(413);
    expect(rows(f)).toEqual([]);
  });

  test("an unknown or malformed room id: 404 room_not_found, never echoing the id", async () => {
    const f = boot();
    for (const id of ["cccccccccccccccccccccccccc", "NOT-A-ROOM", "x".repeat(40)]) {
      const res = await report(f, id, { reason: "spam" });
      expect(res.status).toBe(404);
      const text = await res.text();
      const body = v.parse(ReportResponseSchema, JSON.parse(text));
      expect(body.ok ? null : body.error.code).toBe("room_not_found");
      expect(text).not.toContain(id);
    }
  });
});

describe("redactNote", () => {
  test("replaces emails, IPv4 and IPv6 addresses and phone-like runs; keeps links", () => {
    expect(redactNote("mail ada.l@example.org now")).toBe("mail <email> now");
    expect(redactNote("from 203.0.113.9 and 2001:db8::1")).toBe("from <ip> and <ip>");
    expect(redactNote("call +44 20 7946 0958 or 555-123-4567 or 555.123.4567")).toBe("call <phone> or <phone> or <phone>");
    expect(redactNote("see https://vimeo.com/76979871 at 12:30, 3 people, 123456")).toBe("see https://vimeo.com/76979871 at 12:30, 3 people, 123456");
  });
});

describe("metrics", () => {
  test("counts outcomes, reasons and the open gauge, never a room id or a note", async () => {
    const f = boot();
    await report(f, ROOM, { reason: "hate", note: "metric-note-text" });
    await report(f, ROOM, { reason: "hate" });
    await report(f, ROOM, { reason: "hate" });
    await report(f, ROOM, { reason: "hate" });
    await report(f, ROOM, "{");
    const text = f.t.server.metricsText();
    expect(text).toContain('omega_reports_total{outcome="received"} 1');
    expect(text).toContain('omega_reports_total{outcome="already_reported"} 2');
    expect(text).toContain('omega_reports_total{outcome="rate_limited"} 2');
    expect(text).toContain('omega_reports_total{outcome="unavailable"} 0');
    expect(text).toContain('omega_reports_received_total{reason="hate"} 1');
    expect(text).toContain('omega_reports_received_total{reason="spam"} 0');
    expect(text).toContain("omega_reports_open 1");
    expect(text).toContain("omega_takedowns_total 0");
    expect(text).not.toContain(ROOM);
    expect(text).not.toContain("metric-note-text");
    expect(text).not.toContain("198.51.100");
  });
});

describe("retention", () => {
  test(`rows and duplicate marks go ${String(REPORT_RETENTION_MS / 86_400_000)} days after created_at, whatever their state`, async () => {
    const f = boot();
    await report(f, ROOM, { reason: "spam" });
    await report(f, OTHER, { reason: "spam" }, "198.51.100.8");
    f.reportStore.dismissRoom(OTHER);
    f.wall.ms = T0 + REPORT_RETENTION_MS - 1;
    f.t.server.reports.purge();
    expect(rows(f)).toHaveLength(2);
    f.wall.ms = T0 + REPORT_RETENTION_MS;
    f.t.server.reports.purge();
    expect(rows(f)).toEqual([]);
    expect(f.t.server.reports.dedupSize).toBe(0);
    f.mono.ms += REPORT_KEY_REFILL_MS;
    expect((await report(f, ROOM, { reason: "spam" })).status).toBe(202);
  });

  test("the room GC sweep purges them", () => {
    const d = openDatabase(":memory:");
    db = d;
    const reportStore = new ReportStore(d);
    reportStore.add({ id: "o".repeat(22), roomId: ROOM, reason: "spam", note: null, roomTitle: null, embedUrl: null, createdAt: T0 - REPORT_RETENTION_MS });
    t = start({ store: new RoomStore(d), reportStore, wallNow: () => T0, roomGcIntervalMs: 60_000 });
    // The boot sweep.
    expect(d.query("SELECT 1 FROM reports").all()).toEqual([]);
  });
});
