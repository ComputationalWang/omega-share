import * as v from "valibot";
import { RoomLayoutSchema, type RoomId, type RoomLayout } from "@omega/shared";

// A saved layout chosen at room creation (OME-910): the room is made as the "empty" preset, then the owner's first
// join sends this one `layout-set`. It lives in sessionStorage for the hop from the home page to the room page.

export interface PendingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const pendingLayoutKey = (roomId: RoomId): string => `omega.pendingLayout.${roomId}`;

export function stashPendingLayout(store: Pick<PendingStore, "setItem">, roomId: RoomId, layout: RoomLayout): boolean {
  try {
    store.setItem(pendingLayoutKey(roomId), JSON.stringify(layout));
    return true;
  } catch {
    return false;
  }
}

/** Reads, validates and removes the key. Anything missing or invalid is null. Never throws. */
export function takePendingLayout(store: Pick<PendingStore, "getItem" | "removeItem">, roomId: RoomId): RoomLayout | null {
  const key = pendingLayoutKey(roomId);
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    store.removeItem(key);
    const r = v.safeParse(RoomLayoutSchema, JSON.parse(raw));
    return r.success ? r.output : null;
  } catch {
    return null;
  }
}
