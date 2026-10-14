// Builds a database through the TS stores and dumps one through them (ADR 0050 rollback proof, OME-1144).
// The Rust side does the same in `tests/store_interop.rs`; the two dumps must be equal.
import { Database } from "bun:sqlite";
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
}
export interface SpecFile {
  rooms: SpecRoom[];
  seatHolds: { roomId: string; nameHash: string; seat: number }[];
  reports: NewReport[];
  dismiss: string[];
  actionRooms: string[];
  takedowns: { roomId: string; at: number }[];
}
/** The literal in spec.ts has the same shape; this is the check. */
export const asSpecFile = (s: Spec): SpecFile => s as SpecFile;

const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b: Uint8Array | null): string | null => (b === null ? null : Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
const embed = (e: unknown): AnyEmbed => v.parse(AnyEmbedSchema, e);
const layout = (l: unknown): RoomLayout => v.parse(RoomLayoutSchema, l);
const item = (i: SpecItem): { id: ReturnType<typeof qid>; embed: AnyEmbed } => ({ id: qid(i.id), embed: embed(i.embed) });
const qid = (s: string) => v.parse(QueueItemIdSchema, s);

/** Writes the spec through the TS stores into a fresh database file, checkpointed and closed. */
export function build(spec: SpecFile, path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  const db = openDatabase(path);
  const rooms = new RoomStore(db);
  const reports = new ReportStore(db);
  for (const r of spec.rooms) {
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
  }
  const holds: SeatHold[] = spec.seatHolds.map((h) => ({ roomId: h.roomId, nameHash: fromHex(h.nameHash), seat: h.seat }) as SeatHold);
  rooms.saveSeatHolds(holds);
  for (const r of spec.rooms) if (r.deleted === true) rooms.deleteRoom(r.id);
  for (const r of spec.reports) reports.add(r);
  for (const id of spec.dismiss) reports.dismiss(id);
  for (const id of spec.actionRooms) reports.actionRoom(id);
  for (const t of spec.takedowns) reports.addTakedown(t.roomId, t.at);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  // Checkpointed with TRUNCATE: the side files are empty, and the main file is the whole database.
  for (const suffix of ["-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

type Json = null | number | string | Json[] | { [k: string]: Json };

/** Every row of `sql`, columns by name, blobs as lowercase hex. */
function raw(db: Database, sql: string): Json[] {
  return db.query<Record<string, unknown>, []>(sql).all().map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, val]) => [k, val instanceof Uint8Array ? (toHex(val) as string) : (val as Json)])),
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
      rawReports: raw(db, "SELECT * FROM reports ORDER BY id"),
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
      openReports: reports.listOpen() as unknown as Json,
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
