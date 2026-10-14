import * as v from "valibot";
import { RoomLayoutSchema, canonicalizeAnyEmbed, type ClientMessage, type RoomId, type RoomLayout } from "@omega/shared";

// A saved layout chosen at room creation (OME-910): the room is made as the "empty" preset, then the owner's first
// join sends this one `layout-set`. It lives in sessionStorage for the hop from the home page to the room page.
// A video link the extension handed over (`#share=`, OME-1085) takes the same hop, and goes in as one `queue-add` after it.

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

/**
 * The room page's half: once the joiner is the owner and the first snapshot is in, sends the stashed layout as one
 * `layout-set` and forgets it. Call `apply` on every state change; it does nothing again after it has acted.
 */
export function createPendingApplier(
  store: Pick<PendingStore, "getItem" | "removeItem">,
  roomId: RoomId,
  send: (msg: ClientMessage) => boolean,
  ownHosts: readonly string[],
): (s: { readonly owner: boolean; readonly hasRoom: boolean }) => void {
  let done = false;
  return (s) => {
    if (done || !s.owner || !s.hasRoom) return;
    done = true;
    const layout = takePendingLayout(store, roomId);
    if (layout !== null) send({ type: "layout-set", layout });
    const url = takePendingShare(store, roomId, ownHosts);
    if (url !== null) send({ type: "queue-add", url });
  };
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

export const pendingShareKey = (roomId: RoomId): string => `omega.pendingShare.${roomId}`;

/** The link, trimmed, when the queue would take it (a synced provider or the ADR 0024 generic tier); else null. */
export function shareableLink(raw: string, ownHosts: readonly string[]): string | null {
  return canonicalizeAnyEmbed(raw, { generic: true, ownHosts }) === null ? null : raw.trim();
}

export function stashPendingShare(store: Pick<PendingStore, "setItem">, roomId: RoomId, url: string): boolean {
  try {
    store.setItem(pendingShareKey(roomId), url);
    return true;
  } catch {
    return false;
  }
}

/** Reads, re-validates (storage is untrusted) and removes the key. Never throws. */
export function takePendingShare(store: Pick<PendingStore, "getItem" | "removeItem">, roomId: RoomId, ownHosts: readonly string[]): string | null {
  const key = pendingShareKey(roomId);
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    store.removeItem(key);
    return shareableLink(raw, ownHosts);
  } catch {
    return null;
  }
}
