import type { RoomId } from "@omega/shared";
import type { Room } from "./room";
import type { RoomRegistry } from "./rooms";
import { logError } from "./log";

/** How often GC sweeps; it also sweeps once at boot (threat model §1.3). */
export const ROOM_GC_INTERVAL_MS = 60 * 60 * 1000;
/** A created room nobody ever joined goes this long after `created_at`. */
export const NEVER_JOINED_TTL_MS = 60 * 60 * 1000;
/** An empty created room goes this long after it last became empty (`last_active_at`). */
export const EMPTY_ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface RoomGcDeps {
  rooms: RoomRegistry;
  /** Unix ms, the clock `created_at` and `last_active_at` are written with. */
  wallNow: () => number;
  /** A member, or a socket still joining: the room is in use and is never collected. */
  busy: (room: Room) => boolean;
  /**
   * Called for every room with members, so its stored `last_active_at` is at most one interval old
   * if the process dies while they are in it (it otherwise last moved when they arrived).
   */
  touch: (room: Room, at: number) => void;
}

/** Whether GC should end an idle room at `now`. Pinned rooms never; occupied ones are checked by the caller. */
function expired(room: Room, now: number): boolean {
  if (room.pinned) return false;
  if (room.lastActiveAt === null) return now - room.createdAt >= NEVER_JOINED_TTL_MS;
  return now - room.lastActiveAt >= EMPTY_ROOM_TTL_MS;
}

/**
 * One sweep, O(rooms). Expired rooms end through `removeRoom`, the path owner deletes take: their
 * sockets close with ROOM_CLOSED, their grants are revoked and their row is deleted. Returns the ids removed.
 */
export function sweepRooms({ rooms, wallNow, busy, touch }: RoomGcDeps): RoomId[] {
  const now = wallNow();
  const due: Room[] = [];
  for (const room of rooms.values()) {
    if (room.memberCount > 0) touch(room, now);
    else if (!busy(room) && expired(room, now)) due.push(room);
  }
  const removed: RoomId[] = [];
  for (const room of due) {
    // One room's failure (a store error in an onRemove hook) must not leave the others for another hour.
    try {
      rooms.removeRoom(room);
      removed.push(room.id);
    } catch (err) {
      logError("gc.remove", err);
    }
  }
  return removed;
}

/** Sweeps now and then every `intervalMs` (default ROOM_GC_INTERVAL_MS). The timer never keeps the process alive. */
export function startRoomGc(deps: RoomGcDeps & { intervalMs?: number }): { stop: () => void } {
  const sweep = (): void => {
    try {
      sweepRooms(deps);
    } catch (err) {
      logError("gc.sweep", err);
    }
  };
  sweep();
  const timer = setInterval(sweep, deps.intervalMs ?? ROOM_GC_INTERVAL_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
