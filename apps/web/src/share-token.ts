import { SHARE_TOKEN_STORAGE_KEY, type RoomId, type ShareTokenRecord } from "@omega/shared";
import type { ConnectionEvent } from "./connection";

/** The part of `Storage` we use (`sessionStorage` in the page). */
export interface ShareTokenStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ShareTokenTracker {
  onEvent(e: ConnectionEvent): void;
  /** The page is leaving the room (pagehide). */
  clear(): void;
}

/**
 * Keeps `sessionStorage["omega.share"]` in step with this member's share token, so the extension
 * can read it from the room tab (ADR 0015 §7). Never in a URL: the Twitch SDK forwards the page URL.
 */
export function trackShareToken(storage: ShareTokenStorage, roomId: RoomId): ShareTokenTracker {
  // Storage can be disabled or full; the room works without a record, the extension just can't share.
  const clear = (): void => {
    try {
      storage.removeItem(SHARE_TOKEN_STORAGE_KEY);
    } catch {
      /* nothing to clear */
    }
  };
  return {
    onEvent(e) {
      if (e.type === "disconnected") clear();
      if (e.type !== "message") return;
      if (e.msg.type === "room-full") clear();
      if (e.msg.type !== "snapshot") return;
      if (e.msg.shareToken === undefined) {
        clear();
        return;
      }
      const record: ShareTokenRecord = { roomId, token: e.msg.shareToken };
      try {
        storage.setItem(SHARE_TOKEN_STORAGE_KEY, JSON.stringify(record));
      } catch {
        /* see above */
      }
    },
    clear,
  };
}
