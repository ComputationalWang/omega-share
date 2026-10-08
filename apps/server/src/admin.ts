import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import * as v from "valibot";
import { RoomIdSchema, RoomVisibilitySchema, type RoomId } from "@omega/shared";
import type { RoomRegistry } from "./rooms";
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
 */

/** One `GET /rooms` entry. Strict, so a field like a hash can't slip into the CLI's output unnoticed. */
export const AdminRoomSchema = v.strictObject({
  id: RoomIdSchema,
  title: v.string(),
  visibility: RoomVisibilitySchema,
  /** Unix ms. */
  createdAt: v.number(),
  /** Unix ms the room last became occupied or empty; null if nobody ever joined. */
  lastActiveAt: v.nullable(v.number()),
  pinned: v.boolean(),
  members: v.number(),
});
export type AdminRoom = v.InferOutput<typeof AdminRoomSchema>;
export const AdminRoomListSchema = v.strictObject({ rooms: v.array(AdminRoomSchema) });
export const AdminErrorSchema = v.object({ error: v.string() });

export interface AdminOptions {
  rooms: RoomRegistry;
  store: Pick<RoomStore, "deleteRoom" | "setPinned">;
  socketPath: string;
}

export interface AdminServer {
  stop: () => Promise<void>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noRoom = (id: string): Response => json(404, { error: `no room ${id}` });

const ROOM_PATH = /^\/rooms\/([^/]+)(?:\/(pin|unpin))?$/;

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

function handle(req: Request, { rooms, store }: AdminOptions): Response {
  const { pathname } = new URL(req.url);
  if (pathname === "/rooms") return req.method === "GET" ? json(200, { rooms: listRooms(rooms) }) : json(405, { error: "method not allowed" });
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
  if (room === undefined) return noRoom(roomId);
  const pinned = verb === "pin";
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

/** Listens on `socketPath` (mode 0600). Throws if the path is taken by something that isn't a socket. */
export function startAdmin(opts: AdminOptions): AdminServer {
  clearStaleSocket(opts.socketPath);
  const server = Bun.serve({
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
  chmodSync(opts.socketPath, 0o600);
  return {
    stop: async () => {
      await server.stop(true);
    },
  };
}
