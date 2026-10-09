import {
  REPORT_KEY_BURST,
  REPORT_KEY_REFILL_MS,
  REPORT_MAX_OPEN,
  REPORT_RETENTION_MS,
  REPORT_ROOM_BURST,
  REPORT_ROOM_REFILL_MS,
  type ReportRequest,
  type RoomId,
} from "@omega/shared";
import type { AdminReportRoom } from "./admin";
import { logError, redactAddresses } from "./log";
import type { Metrics, ReportOutcome } from "./metrics";
import { KeyedLimiter, TokenBucket, isLoopbackKey, type Clock } from "./rate-limit";
import type { Room } from "./room";
import type { RoomRegistry } from "./rooms";
import { mintSecret } from "./secrets";
import { REPORT_MAX_ROWS, type ReportStore } from "./store/reports";

/**
 * Abuse reports (ADR 0033): the limits, the in-memory duplicate set, what a report stores, and the
 * operator's side (queue, dismiss, takedown). Reports are never logged and never reach a room.
 */

/** Most duplicate marks held: one per stored report at most, so no more than the table's rows. */
export const MAX_DEDUP_ENTRIES = REPORT_MAX_ROWS;

/**
 * Phone-number-like: 7 or more digits, with single spaces, dots or dashes between them and an optional
 * leading `+`. Not inside a word or a URL path or query (`/76979871`), so links stay usable as evidence.
 */
const PHONE = /(?<![\w/.=?&#%+:-])\+?\d(?:[ .-]?\d){6,}(?!\w)/g;

/** A note as stored (ADR 0033 §3): emails, IP addresses and phone numbers redacted. The note is already ≤ 300 chars. */
export const redactNote = (note: string): string => redactAddresses(note).replace(PHONE, "<phone>");

/**
 * Which client keys reported which room, for `already_reported` (ADR 0033 §3). Memory only, never written,
 * logged or counted. Insertion order is report order, so the oldest mark is evicted first at the cap.
 */
export class ReportDedup {
  readonly #marks = new Map<string, { room: RoomId; at: number }>();

  get size(): number {
    return this.#marks.size;
  }

  has(room: RoomId, key: string): boolean {
    return this.#marks.has(`${room} ${key}`);
  }

  add(room: RoomId, key: string, at: number): void {
    const mark = `${room} ${key}`;
    this.#marks.delete(mark);
    this.#marks.set(mark, { room, at });
    if (this.#marks.size > MAX_DEDUP_ENTRIES) {
      const oldest = this.#marks.keys().next();
      if (oldest.done !== true) this.#marks.delete(oldest.value);
    }
  }

  /** Drops marks made at or before `cutoff` (their rows are purged with them). */
  expire(cutoff: number): void {
    for (const [mark, { at }] of this.#marks) if (at <= cutoff) this.#marks.delete(mark);
  }

  /** The room is gone, taken down, or its reports were dismissed: it may be reported afresh. */
  dropRoom(room: RoomId): void {
    for (const [mark, m] of this.#marks) if (m.room === room) this.#marks.delete(mark);
  }
}

/** What `file` decided after the key bucket and the parse. */
export type FileResult =
  | { status: "received" | "already_reported" }
  | { code: "rate_limited"; retryAfterMs: number }
  | { code: "unavailable" };

export interface ReportsDeps {
  rooms: RoomRegistry;
  store: ReportStore;
  /** Deletes a room's row (and so its queue and seat holds); false if there was none. */
  deleteRoomRow: (id: RoomId) => void;
  metrics: Metrics;
  /** Monotonic, for the buckets. */
  now: Clock;
  /** Unix ms, for `created_at` and retention. */
  wallNow: () => number;
}

/** What the operator socket (`admin.ts`) uses. */
export interface ReportsAdmin {
  /** Open reports grouped by room, most reported first. */
  list(): AdminReportRoom[];
  /** 1 if the report was open, else 0. */
  dismiss(id: string): number;
  dismissRoom(roomId: RoomId): number;
  /** Ends the room for good (ADR 0033 §5). Throws, changing nothing, if the tombstone can't be written. */
  takedown(roomId: RoomId): { live: boolean };
  isTakenDown: (id: string) => boolean;
  /** Retention: the GC sweep runs it. */
  purge: () => void;
  readonly dedupSize: number;
  openCount: () => number;
}

export interface Reports extends ReportsAdmin {
  /** The key bucket, before the body is parsed: 0 if a report may go ahead, else the wait in ms. Loopback skips it. */
  admitKey(key: string): number;
  /** The rest of the check order: room bucket → duplicate → open cap → store. */
  file(room: Room, key: string, request: ReportRequest): FileResult;
  /** An answer decided before `file` (bad body, unknown room, key bucket), for `/metrics`. */
  count(outcome: ReportOutcome): void;
}

/** A key a duplicate can be pinned on: not loopback (dev, tests), not the shared `proxy:unknown` or an unknown peer. */
const usableKey = (key: string): boolean => !isLoopbackKey(key) && key !== "proxy:unknown" && key !== "unknown";

export function createReports({ rooms, store, deleteRoomRow, metrics, now, wallNow }: ReportsDeps): Reports {
  const keys = new KeyedLimiter(REPORT_KEY_BURST, 1000 / REPORT_KEY_REFILL_MS, 1024, now);
  // Dropped with the room (RoomRegistry.removeRoom).
  const roomBuckets = rooms.perRoom(() => new TokenBucket(REPORT_ROOM_BURST, 1000 / REPORT_ROOM_REFILL_MS, now));
  const dedup = new ReportDedup();
  const takenDown = new Set<string>(store.takedowns());
  rooms.onRemove((room) => {
    dedup.dropRoom(room.id);
  });

  const list = (): AdminReportRoom[] => {
    const byRoom = new Map<RoomId, AdminReportRoom>();
    // Newest first, so each room's reports stay newest first.
    for (const r of store.listOpen()) {
      let entry = byRoom.get(r.roomId);
      if (entry === undefined) {
        const room = rooms.get(r.roomId);
        entry =
          room === undefined
            ? { id: r.roomId, state: takenDown.has(r.roomId) ? "taken_down" : "gone", title: null, visibility: null, members: null, reports: [] }
            : { id: r.roomId, state: "live", title: room.title, visibility: room.visibility, members: room.memberCount, reports: [] };
        byRoom.set(r.roomId, entry);
      }
      entry.reports.push({ id: r.id, createdAt: r.createdAt, reason: r.reason, note: r.note, title: r.roomTitle, embedUrl: r.embedUrl });
    }
    const newest = (e: AdminReportRoom): number => e.reports[0]?.createdAt ?? 0;
    return [...byRoom.values()].sort((a, b) => b.reports.length - a.reports.length || newest(b) - newest(a) || (a.id < b.id ? -1 : 1));
  };

  return {
    admitKey(key) {
      if (isLoopbackKey(key) || keys.take(key)) return 0;
      return Math.max(1000, keys.retryAfterMs(key, REPORT_KEY_REFILL_MS));
    },
    file(room, key, request) {
      const bucket = roomBuckets.get(room);
      if (!bucket.take()) {
        metrics.countReport("rate_limited");
        return { code: "rate_limited", retryAfterMs: Math.max(1000, bucket.retryAfterMs(REPORT_ROOM_REFILL_MS)) };
      }
      const keyed = usableKey(key);
      if (keyed && dedup.has(room.id, key)) {
        metrics.countReport("already_reported");
        return { status: "already_reported" };
      }
      try {
        if (store.openCount() >= REPORT_MAX_OPEN) {
          metrics.countReport("unavailable");
          return { code: "unavailable" };
        }
        const embed = room.currentEmbed;
        store.add({
          id: mintSecret(),
          roomId: room.id,
          reason: request.reason,
          note: request.note === undefined ? null : redactNote(request.note),
          roomTitle: room.title === "" ? null : room.title,
          embedUrl: embed === null ? null : embed.url,
          createdAt: wallNow(),
        });
      } catch (err) {
        // The event and the error class only: the message is cut at its first quote and scrubbed (log.ts).
        logError("store.report", err);
        bucket.refund();
        if (!isLoopbackKey(key)) keys.refund(key);
        metrics.countReport("unavailable");
        return { code: "unavailable" };
      }
      if (keyed) dedup.add(room.id, key, wallNow());
      metrics.countReport("received", request.reason);
      return { status: "received" };
    },
    count(outcome) {
      metrics.countReport(outcome);
    },
    list,
    dismiss: (id) => (store.dismiss(id) ? 1 : 0),
    dismissRoom(roomId) {
      const n = store.dismissRoom(roomId);
      dedup.dropRoom(roomId);
      return n;
    },
    takedown(roomId) {
      // The tombstone first: if it can't be written, the room is left as it was.
      store.addTakedown(roomId, wallNow());
      takenDown.add(roomId);
      const room = rooms.get(roomId);
      const live = room !== undefined && rooms.removeRoom(room, "taken_down");
      // removeRoom's hook deleted the row already; this catches one a failed earlier delete left behind.
      try {
        deleteRoomRow(roomId);
      } catch (err) {
        logError("store.delete_room", err);
      }
      store.actionRoom(roomId);
      dedup.dropRoom(roomId);
      metrics.countTakedown();
      return { live };
    },
    isTakenDown: (id) => takenDown.has(id),
    purge: () => {
      const now = wallNow();
      store.purge(now - REPORT_RETENTION_MS + 1);
      dedup.expire(now - REPORT_RETENTION_MS);
    },
    get dedupSize() {
      return dedup.size;
    },
    openCount: () => store.openCount(),
  };
}
