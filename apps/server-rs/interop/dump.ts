// Builds a database through the TS stores and dumps one through them (ADR 0050 rollback proof, OME-1144).
// The Rust side does the same in `tests/store_interop.rs`; the two dumps must be equal.
import type { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnyEmbedSchema, QueueItemIdSchema, RoomLayoutSchema, type AnyEmbed, type RoomLayout } from "@omega/shared";
import * as v from "valibot";
import { openDatabase } from "../../server/src/store/db";
import { RoomStore, type SeatHold } from "../../server/src/store/rooms";
import { ReportStore, type NewReport } from "../../server/src/store/reports";
import type { Spec } from "./spec";

interface SpecItem {
  id: string;
  embed: unknown;
}
/** One store call on a room (`room` is implied inside a room's own `ops`). */
interface SpecOp {
  room?: string;
  op: "removeItem" | "addItem" | "advance" | "setTitle" | "setLayout" | "setEmbed" | "setControlPolicy" | "setLastActive" | "setPinned";
  id?: string;
  item?: SpecItem;
  title?: string;
  layout?: unknown;
  embed?: unknown;
  itemId?: string;
  policy?: "everyone" | "owner";
  at?: number;
  pinned?: boolean;
}
interface SpecRoom {
  id: string;
  title: string;
  createdAt: number;
  layout: unknown;
  visibility?: "public" | "private";
  pinned?: boolean;
  ownerHash?: string;
  inviteHash?: string;
  controlPolicy?: "everyone" | "owner";
  lastActiveAt?: number;
  embed?: unknown;
  itemId?: string;
  queue?: SpecItem[];
  then?: "advance" | "addAndStart";
  startItem?: SpecItem;
  unpin?: boolean;
  deleted?: boolean;
  ops?: SpecOp[];
}
interface SpecHold {
  roomId: string;
  nameHash: string;
  seat: number;
}
interface SpecTakedown {
  roomId: string;
  at: number;
}
interface SpecMixed {
  newRooms: SpecRoom[];
  ops: SpecOp[];
  deleteRooms: string[];
  holds: SpecHold[];
  reports: NewReport[];
  dismiss: string[];
  actionRooms: string[];
  takedowns: SpecTakedown[];
  purgeBefore: number;
}
export interface SpecFile {
  rooms: SpecRoom[];
  seatHolds: SpecHold[];
  reports: NewReport[];
  bulk: { first: number; then: number; base: number; closeBelow: number };
  purgeBefore: number;
  dismiss: string[];
  actionRooms: string[];
  takedowns: SpecTakedown[];
  mixed: SpecMixed;
}
/** The literal in spec.ts has the same shape; this is the check. */
export const asSpecFile = (s: Spec): SpecFile => s as SpecFile;

const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toHex = (b: Uint8Array | null): string | null => (b === null ? null : hexOf(b));
const qid = (s: string) => v.parse(QueueItemIdSchema, s);
const embed = (e: unknown): AnyEmbed => v.parse(AnyEmbedSchema, e);
const layout = (l: unknown): RoomLayout => v.parse(RoomLayoutSchema, l);
const item = (i: SpecItem): { id: ReturnType<typeof qid>; embed: AnyEmbed } => ({ id: qid(i.id), embed: embed(i.embed) });
/** Present-or-absent optional property, so `exactOptionalPropertyTypes` stays happy. */
const need = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error("spec op is missing a field");
  return x;
};

function applyOp(rooms: RoomStore, room: string, o: SpecOp): void {
  switch (o.op) {
    case "removeItem":
      rooms.removeQueueItem(room, qid(need(o.id)));
      break;
    case "addItem":
      rooms.addQueueItem(room, item(need(o.item)));
      break;
    case "advance":
      rooms.advanceQueue(room, item(need(o.item)));
      break;
    case "setTitle":
      rooms.setTitle(room, need(o.title));
      break;
    case "setLayout":
      rooms.setLayout(room, layout(o.layout));
      break;
    case "setEmbed":
      rooms.setEmbed(room, o.embed === null ? null : embed(o.embed), o.itemId === undefined ? null : qid(o.itemId));
      break;
    case "setControlPolicy":
      rooms.setControlPolicy(room, need(o.policy));
      break;
    case "setLastActive":
      rooms.setLastActive(room, need(o.at));
      break;
    case "setPinned":
      rooms.setPinned(room, need(o.pinned));
      break;
  }
}

function createRoom(rooms: RoomStore, r: SpecRoom): void {
  rooms.createRoom({
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    layout: layout(r.layout),
    ...(r.visibility === undefined ? {} : { visibility: r.visibility }),
    ...(r.pinned === undefined ? {} : { pinned: r.pinned }),
    ...(r.ownerHash === undefined ? {} : { ownerHash: fromHex(r.ownerHash) }),
    ...(r.inviteHash === undefined ? {} : { inviteHash: fromHex(r.inviteHash) }),
  });
  if (r.lastActiveAt !== undefined) rooms.setLastActive(r.id, r.lastActiveAt);
  if (r.controlPolicy !== undefined) rooms.setControlPolicy(r.id, r.controlPolicy);
  if (r.embed !== undefined) rooms.setEmbed(r.id, embed(r.embed), r.itemId === undefined ? null : qid(r.itemId));
  if (r.then === "addAndStart" && r.startItem !== undefined) rooms.addQueueItemAndStart(r.id, item(r.startItem), item(r.startItem));
  for (const q of r.queue ?? []) rooms.addQueueItem(r.id, item(q));
  const first = r.queue?.[0];
  if (r.then === "advance" && first !== undefined) rooms.advanceQueue(r.id, item(first));
  if (r.unpin === true) rooms.setPinned(r.id, false);
  for (const o of r.ops ?? []) applyOp(rooms, r.id, o);
}

const holdsOf = (hs: SpecHold[]): SeatHold[] => hs.map((h) => ({ roomId: h.roomId, nameHash: fromHex(h.nameHash), seat: h.seat }));
const bulkId = (i: number): string => `bulk${String(i).padStart(18, "0")}`;
const bulkReport = (base: number, i: number): NewReport => ({ id: bulkId(i), roomId: "lobby", reason: "spam", note: null, roomTitle: null, embedUrl: null, createdAt: base + i });

function replay(spec: SpecFile, rooms: RoomStore, reports: ReportStore): void {
  for (const r of spec.rooms) createRoom(rooms, r);
  rooms.saveSeatHolds(holdsOf(spec.seatHolds));
  for (const r of spec.rooms) if (r.deleted === true) rooms.deleteRoom(r.id);
  for (const r of spec.reports) reports.add(r);
  for (const id of spec.dismiss) reports.dismiss(id);
  for (const id of spec.actionRooms) reports.actionRoom(id);
  for (const t of spec.takedowns) reports.addTakedown(t.roomId, t.at);
  const { first, then, base, closeBelow } = spec.bulk;
  for (let i = 0; i < first; i++) reports.add(bulkReport(base, i));
  for (let i = 0; i < closeBelow; i++) reports.dismiss(bulkId(i));
  for (let i = first; i < first + then; i++) reports.add(bulkReport(base, i));
  reports.purge(spec.purgeBefore);
}

function applyMixed(m: SpecMixed, rooms: RoomStore, reports: ReportStore): void {
  for (const r of m.newRooms) createRoom(rooms, r);
  for (const o of m.ops) applyOp(rooms, need(o.room), o);
  for (const id of m.deleteRooms) rooms.deleteRoom(id);
  rooms.saveSeatHolds(holdsOf(m.holds));
  for (const r of m.reports) reports.add(r);
  for (const id of m.dismiss) reports.dismiss(id);
  for (const id of m.actionRooms) reports.actionRoom(id);
  for (const t of m.takedowns) reports.addTakedown(t.roomId, t.at);
  reports.purge(m.purgeBefore);
}

function finish(db: Database, path: string): void {
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  // Checkpointed with TRUNCATE: the side files are empty, and the main file is the whole database.
  for (const suffix of ["-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

/** Writes the spec through the TS stores into a fresh database file, checkpointed and closed. */
export function build(spec: SpecFile, path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  const db = openDatabase(path);
  replay(spec, new RoomStore(db), new ReportStore(db));
  finish(db, path);
}

/** Applies the mixed-history step to an existing database (a file the other server wrote) in place. */
export function mutate(spec: SpecFile, path: string): void {
  const db = openDatabase(path);
  applyMixed(spec.mixed, new RoomStore(db), new ReportStore(db));
  finish(db, path);
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Every row of `sql`, columns by name, blobs as lowercase hex. */
function raw(db: Database, sql: string): Json[] {
  return db.query<Record<string, unknown>, []>(sql).all().map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, val]) => [k, val instanceof Uint8Array ? hexOf(val) : (val as Json)])),
  );
}

/** What the TS stores read from `path` (a copy is opened: the dump takes seat holds and migrates). */
export function dump(path: string): Json {
  const dir = mkdtempSync(join(tmpdir(), "omega-interop-"));
  try {
    const file = join(dir, "copy.db");
    copyFileSync(path, file);
    const db = openDatabase(file);
    const rooms = new RoomStore(db);
    const reports = new ReportStore(db);
    const out: Json = {
      userVersion: (db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? { user_version: -1 }).user_version,
      schema: raw(db, "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
      rawRooms: raw(db, "SELECT * FROM rooms ORDER BY id"),
      rawQueue: raw(db, "SELECT * FROM queue_items ORDER BY room_id, position"),
      rawHolds: raw(db, "SELECT * FROM seat_holds ORDER BY room_id, seat"),
      // The bulk rows (thousands) are summarised, the rest are listed.
      rawReports: raw(db, "SELECT * FROM reports WHERE id NOT LIKE 'bulk%' ORDER BY id"),
      bulkReports: raw(db, "SELECT state, count(*) AS n, min(created_at) AS oldest, max(created_at) AS newest FROM reports WHERE id LIKE 'bulk%' GROUP BY state ORDER BY state"),
      rawTakedowns: raw(db, "SELECT * FROM takedowns ORDER BY room_id"),
      rooms: rooms.listRooms().map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        layout: r.layout as unknown as Json,
        embed: r.embed as unknown as Json,
        visibility: r.visibility,
        pinned: r.pinned,
        ownerHash: toHex(r.ownerHash),
        inviteHash: toHex(r.inviteHash),
        lastActiveAt: r.lastActiveAt,
        controlPolicy: r.controlPolicy,
        itemId: r.itemId,
        queue: r.queue as unknown as Json,
      })),
      openReports: reports.listOpen().filter((r) => !r.id.startsWith("bulk")) as unknown as Json,
      openCount: reports.openCount(),
      takedowns: reports.takedowns().sort(),
      seatHolds: rooms.takeSeatHolds().map((h) => ({ roomId: h.roomId, nameHash: toHex(h.nameHash), seat: h.seat })),
    };
    db.close();
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A copy of `from` at `to`, for mutating without touching a committed fixture. */
export function copyDb(from: string, to: string): void {
  copyFileSync(from, to);
}
