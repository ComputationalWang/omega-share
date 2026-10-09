import { chmodSync, lstatSync, rmSync, unlinkSync } from "node:fs";
import * as v from "valibot";
import { REPORT_REASONS, RoomIdSchema, RoomVisibilitySchema, type RoomId } from "@omega/shared";
import type { ReportsAdmin } from "./reports";
import type { RoomRegistry } from "./rooms";
import { ReportIdSchema } from "./store/reports";
import type { RoomStore } from "./store/rooms";

/**
 * The operator's way in (threat model §4.2 E, ADR 0028 takedowns): a tiny HTTP API on an owner-only
 * Unix socket, never on TCP, so only the service user (and root) can reach it. `cli.ts` is its one
 * client. It lives in the server process because a takedown must end the live room through
 * `removeRoom` (sockets closed with ROOM_CLOSED, grants revoked) and a pin must reach GC's memory.
 *
 *   GET    /rooms           every room, private ones included, never a secret or a hash
 *   DELETE /rooms/:id       removeRoom, then the row
 *   POST   /rooms/:id/pin   GC never collects it
 *   POST   /rooms/:id/unpin GC may collect it again
 *   POST   /rooms/:id/takedown          ends the room for good (ADR 0033 §5): 4006, tombstone, reports actioned
 *   GET    /reports                     open abuse reports, grouped by room
 *   POST   /reports/:id/dismiss         dismisses one report
 *   POST   /rooms/:id/reports/dismiss   dismisses the room's open reports
 */

/** One `GET /rooms` entry. Strict, so a field like a hash can't slip into the CLI's output unnoticed. */
export const AdminRoomSchema = v.strictObject({
  id: RoomIdSchema,
  title: v.string(),
  visibility: RoomVisibilitySchema,
  /** Unix ms. */
  createdAt: v.pipe(v.number(), v.safeInteger()),
  /** Unix ms the room last became occupied or empty; null if nobody ever joined. */
  lastActiveAt: v.nullable(v.pipe(v.number(), v.safeInteger())),
  pinned: v.boolean(),
  members: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export type AdminRoom = v.InferOutput<typeof AdminRoomSchema>;
export const AdminRoomListSchema = v.strictObject({ rooms: v.array(AdminRoomSchema) });
export const AdminErrorSchema = v.object({ error: v.string() });

const UnixMs = v.pipe(v.number(), v.safeInteger());
const NullableText = v.nullable(v.string());
/** One open report as the operator sees it: what the table holds (ADR 0033 §3), nothing more. */
export const AdminReportSchema = v.strictObject({
  id: ReportIdSchema,
  createdAt: UnixMs,
  reason: v.picklist(REPORT_REASONS),
  note: NullableText,
  /** The room's title at report time. */
  title: NullableText,
  /** What was playing at report time. */
  embedUrl: NullableText,
});
/** A reported room: its state now, and its open reports, newest first. Strict, like AdminRoomSchema. */
export const AdminReportRoomSchema = v.strictObject({
  id: RoomIdSchema,
  state: v.picklist(["live", "taken_down", "gone"]),
  /** Now; null unless live. */
  title: NullableText,
  visibility: v.nullable(RoomVisibilitySchema),
  members: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  reports: v.array(AdminReportSchema),
});
export type AdminReportRoom = v.InferOutput<typeof AdminReportRoomSchema>;
export const AdminReportListSchema = v.strictObject({ rooms: v.array(AdminReportRoomSchema) });

export interface AdminOptions {
  rooms: RoomRegistry;
  store: Pick<RoomStore, "deleteRoom" | "setPinned">;
  /** The report queue and takedowns (ADR 0033 §5). Without it, those routes answer 503. */
  reports?: ReportsAdmin;
  socketPath: string;
}

export interface AdminServer {
  stop: () => Promise<void>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noRoom = (id: string): Response => json(404, { error: `no room ${id}` });

const ROOM_PATH = /^\/rooms\/([^/]+)(?:\/(pin|unpin|takedown|reports\/dismiss))?$/;
const REPORT_PATH = /^\/reports\/([^/]+)\/dismiss$/;
const noReports = (): Response => json(503, { error: "reports are not available on this server" });

function listRooms(rooms: RoomRegistry): AdminRoom[] {
  return [...rooms.values()]
    .map((r) => ({
      id: r.id,
      title: r.title,
      visibility: r.visibility,
      createdAt: r.createdAt,
      lastActiveAt: r.lastActiveAt,
      pinned: r.pinned,
      members: r.memberCount,
    }))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function handle(req: Request, { rooms, store, reports }: AdminOptions): Response {
  const { pathname } = new URL(req.url);
  if (pathname === "/rooms") return req.method === "GET" ? json(200, { rooms: listRooms(rooms) }) : json(405, { error: "method not allowed" });
  if (pathname === "/reports") {
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    return reports === undefined ? noReports() : json(200, { rooms: reports.list() });
  }
  const reportMatch = REPORT_PATH.exec(pathname);
  if (reportMatch !== null) {
    const id = v.safeParse(ReportIdSchema, reportMatch[1]);
    if (!id.success) return json(404, { error: "not found" });
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    if (reports === undefined) return noReports();
    return reports.dismiss(id.output) === 0 ? json(404, { error: `no open report ${id.output}` }) : json(200, { dismissed: 1 });
  }
  const match = ROOM_PATH.exec(pathname);
  const id = v.safeParse(RoomIdSchema, match?.[1]);
  if (match === null || !id.success) return json(404, { error: "not found" });
  const roomId: RoomId = id.output;
  const verb = match[2];
  const room = rooms.get(roomId);
  if (verb === undefined) {
    if (req.method !== "DELETE") return json(405, { error: "method not allowed" });
    const live = room !== undefined && rooms.removeRoom(room);
    // removeRoom's hook deleted the row already; this catches a row a failed earlier delete left behind.
    const stored = store.deleteRoom(roomId);
    return live || stored ? json(200, { deleted: roomId }) : noRoom(roomId);
  }
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  if (verb === "takedown" || verb === "reports/dismiss") {
    if (reports === undefined) return noReports();
    // A room that is no longer live may still be reported, and taken down.
    if (verb === "reports/dismiss") return json(200, { dismissed: reports.dismissRoom(roomId) });
    return json(200, { takenDown: roomId, live: reports.takedown(roomId).live });
  }
  if (room === undefined) return noRoom(roomId);
  const pinned = verb === "pin";
  // A seeded room has no owner to delete it; unpinned, GC would end it and only a restart re-seeds it.
  if (!pinned && !room.hasOwner) return json(409, { error: `${roomId} is a seeded room with no owner: it stays pinned (delete it instead)` });
  // Store first: if the write fails, memory still matches the row.
  store.setPinned(roomId, pinned);
  room.pinned = pinned;
  return json(200, { pinned, id: roomId });
}

/** Removes a socket file a crashed server left behind; refuses anything else at that path. */
function clearStaleSocket(path: string): void {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(path).isSocket();
  } catch {
    return;
  }
  if (!isSocket) throw new Error(`admin socket ${path}: exists and is not a socket`);
  unlinkSync(path);
}

/**
 * Listens on `socketPath`, mode 0600 from the moment it exists: the bind runs under umask 0177, so
 * there is no window before the chmod (which stays, for a filesystem that ignores the umask). Throws
 * if the path is taken by something that isn't a socket, or if the socket can't be secured; then
 * nothing is left listening.
 */
export function startAdmin(opts: AdminOptions): AdminServer {
  clearStaleSocket(opts.socketPath);
  const umask = process.umask(0o177);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: opts.socketPath,
      maxRequestBodySize: 1024,
      fetch(req) {
        try {
          return handle(req, opts);
        } catch (err) {
          return json(500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  } finally {
    process.umask(umask);
  }
  try {
    chmodSync(opts.socketPath, 0o600);
  } catch (err) {
    void server.stop(true);
    // Bun unlinks it on stop; make sure, without failing if it did.
    rmSync(opts.socketPath, { force: true });
    throw err;
  }
  return {
    stop: async () => {
      await server.stop(true);
    },
  };
}
