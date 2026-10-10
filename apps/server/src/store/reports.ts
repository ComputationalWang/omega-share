import type { Database, Statement } from "bun:sqlite";
import * as v from "valibot";
import { MAX_URL_LENGTH, REPORT_MAX_OPEN, REPORT_REASONS, RoomIdSchema, type ReportReason, type RoomId } from "@omega/shared";
import { logError } from "../log";

/**
 * Most rows `reports` holds, whatever their state (ADR 0033 §3, QA on OME-604). Open rows stop at
 * REPORT_MAX_OPEN; dismissed and actioned ones would otherwise pile up for the 30 days of retention,
 * so past this the oldest closed rows make room.
 */
export const REPORT_MAX_ROWS = 5 * REPORT_MAX_OPEN;

/** 16 random bytes, base64url: the operator's handle, never sent to the reporter. */
export const ReportIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/));

/** One report as written: the room's snapshot at report time, nothing about the reporter (ADR 0033 §3). */
export interface NewReport {
  id: string;
  roomId: RoomId;
  reason: ReportReason;
  /** Parsed and redacted; null without a note. */
  note: string | null;
  /** The room's title at report time; null for an untitled room. */
  roomTitle: string | null;
  /** The canonical URL of what was playing; null with nothing playing. */
  embedUrl: string | null;
  /** Unix ms. */
  createdAt: number;
}
export type StoredReport = NewReport;

const UnixMsSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** Bounded, so a hand-edited row can't flood the operator's terminal. */
const TextSchema = v.nullable(v.pipe(v.string(), v.maxLength(1024)));

const NewReportSchema = v.object({
  id: ReportIdSchema,
  roomId: RoomIdSchema,
  reason: v.picklist(REPORT_REASONS),
  note: TextSchema,
  roomTitle: TextSchema,
  embedUrl: v.nullable(v.pipe(v.string(), v.maxLength(MAX_URL_LENGTH))),
  createdAt: UnixMsSchema,
});

/** The DB file is a boundary too: rows are parsed on read, and a bad one is left out. */
const RowSchema = v.object({
  id: ReportIdSchema,
  room_id: RoomIdSchema,
  reason: v.picklist(REPORT_REASONS),
  note: TextSchema,
  room_title: TextSchema,
  embed_url: TextSchema,
  created_at: UnixMsSchema,
});
type Row = Record<keyof v.InferInput<typeof RowSchema>, unknown>;

/** Reports and takedowns (migration 0006). Written only by a report or an operator command, never on the relay path. */
export class ReportStore {
  readonly #db: Database;
  readonly #insert: Statement<unknown, [string, string, string, string | null, string | null, string | null, number]>;
  readonly #count: Statement<{ n: number }, []>;
  readonly #countOpen: Statement<{ n: number }, []>;
  readonly #trim: Statement<unknown, [number]>;
  readonly #listOpen: Statement<Row, []>;
  readonly #dismiss: Statement<unknown, [string]>;
  readonly #closeRoom: Statement<unknown, [string, string]>;
  readonly #purge: Statement<unknown, [number]>;
  readonly #addTakedown: Statement<unknown, [string, number]>;
  readonly #takedowns: Statement<{ room_id: unknown }, []>;

  constructor(db: Database) {
    this.#db = db;
    this.#insert = db.prepare(
      "INSERT INTO reports (id, room_id, reason, note, room_title, embed_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.#count = db.prepare("SELECT count(*) AS n FROM reports");
    this.#countOpen = db.prepare("SELECT count(*) AS n FROM reports WHERE state = 'open'");
    this.#trim = db.prepare("DELETE FROM reports WHERE id IN (SELECT id FROM reports WHERE state != 'open' ORDER BY created_at, id LIMIT ?)");
    this.#listOpen = db.prepare(
      "SELECT id, room_id, reason, note, room_title, embed_url, created_at FROM reports WHERE state = 'open' ORDER BY created_at DESC, id",
    );
    this.#dismiss = db.prepare("UPDATE reports SET state = 'dismissed' WHERE id = ? AND state = 'open'");
    this.#closeRoom = db.prepare("UPDATE reports SET state = ? WHERE room_id = ? AND state = 'open'");
    this.#purge = db.prepare("DELETE FROM reports WHERE created_at < ?");
    this.#addTakedown = db.prepare("INSERT OR IGNORE INTO takedowns (room_id, at) VALUES (?, ?)");
    this.#takedowns = db.prepare("SELECT room_id FROM takedowns");
  }

  /**
   * `GET /healthz`'s database check (OME-840): reads the schema version, which throws if the database is closed
   * or unreadable. `query`, not a kept statement: a statement prepared earlier keeps answering after `close()`.
   */
  ping(): void {
    this.#db.query("PRAGMA user_version").get();
  }

  /** Stores one report; past REPORT_MAX_ROWS the oldest closed rows go first, in the same transaction. Throws if it can't. */
  add(report: NewReport): void {
    const r = v.parse(NewReportSchema, report);
    this.#db.transaction(() => {
      const over = (this.#count.get()?.n ?? 0) - REPORT_MAX_ROWS + 1;
      if (over > 0) this.#trim.run(over);
      this.#insert.run(r.id, r.roomId, r.reason, r.note, r.roomTitle, r.embedUrl, r.createdAt);
    })();
  }

  openCount(): number {
    return this.#countOpen.get()?.n ?? 0;
  }

  /** Open reports, newest first. */
  listOpen(): StoredReport[] {
    const out: StoredReport[] = [];
    for (const row of this.#listOpen.all()) {
      const parsed = v.safeParse(RowSchema, row);
      if (!parsed.success) {
        logError("store.report", new Error(v.summarize(parsed.issues)));
        continue;
      }
      const r = parsed.output;
      out.push({ id: r.id, roomId: r.room_id, reason: r.reason, note: r.note, roomTitle: r.room_title, embedUrl: r.embed_url, createdAt: r.created_at });
    }
    return out;
  }

  /** False if there is no open report with that id. */
  dismiss(id: string): boolean {
    return this.#dismiss.run(id).changes > 0;
  }

  /** Dismisses the room's open reports; returns how many. */
  dismissRoom(roomId: RoomId): number {
    return this.#closeRoom.run("dismissed", roomId).changes;
  }

  /** A takedown: the room's open reports become `actioned`; returns how many. */
  actionRoom(roomId: RoomId): number {
    return this.#closeRoom.run("actioned", roomId).changes;
  }

  /** Retention (ADR 0033 §3): deletes every row created before `before`, whatever its state. */
  purge(before: number): number {
    return this.#purge.run(before).changes;
  }

  /** True when this wrote the tombstone; false when the id was already taken down. */
  addTakedown(roomId: RoomId, at: number): boolean {
    return this.#addTakedown.run(v.parse(RoomIdSchema, roomId), v.parse(UnixMsSchema, at)).changes > 0;
  }

  /** Every taken-down room id. A row that isn't a room id can't match one, and is skipped. */
  takedowns(): RoomId[] {
    const out: RoomId[] = [];
    for (const row of this.#takedowns.all()) {
      const parsed = v.safeParse(RoomIdSchema, row.room_id);
      if (parsed.success) out.push(parsed.output);
    }
    return out;
  }
}
