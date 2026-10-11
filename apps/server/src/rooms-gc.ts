import type { RoomId } from "@omega/shared";
import type { Room } from "./room";
import type { RoomRegistry } from "./rooms";
import { logError } from "./log";

/** How often GC sweeps; it also sweeps once at boot. A room goes 20-21 min after it emptied (ADR 0028 §2, OME-904). */
export const ROOM_GC_INTERVAL_MS = 60 * 1000;
/** A room with nobody in it goes this long after the last member left (`last_active_at`), or after `created_at` if nobody ever joined. */
export const ROOM_IDLE_TTL_MS = 20 * 60 * 1000;

export interface RoomGcDeps {
  rooms: RoomRegistry;
  /** Unix ms, the clock `created_at` and `last_active_at` are written with. */
  wallNow: () => number;
  /**
   * Called for every room with members, so its stored `last_active_at` is at most one interval old
   * if the process dies while they are in it (it otherwise last moved when they arrived).
   */
  touch: (room: Room, at: number) => void;
  /** Runs after each sweep: report retention (ADR 0033 §3). */
  purge?: () => void;
}

/** Whether GC should end an idle room at `now`. Pinned rooms never; occupied ones are checked by the caller. */
function expired(room: Room, now: number): boolean {
  if (room.pinned) return false;
  return now - (room.lastActiveAt ?? room.createdAt) >= ROOM_IDLE_TTL_MS;
}

/**
 * One sweep, O(rooms) over the in-memory registry: no store read. Expired rooms end through `removeRoom`, the path owner deletes take: their
 * sockets close with ROOM_CLOSED, their grants are revoked and their row is deleted. Returns the ids removed.
 */
export function sweepRooms({ rooms, wallNow, touch }: RoomGcDeps): RoomId[] {
  const now = wallNow();
  const due: Room[] = [];
  for (const room of rooms.values()) {
    if (room.memberCount > 0) touch(room, now);
    else if (expired(room, now)) due.push(room);
  }
  const removed: RoomId[] = [];
  for (const room of due) {
    // One room's failure (a store error in an onRemove hook) must not leave the others for another sweep.
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
    try {
      deps.purge?.();
    } catch (err) {
      logError("gc.purge", err);
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
