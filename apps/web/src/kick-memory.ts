import { KICK_COOLDOWN_MS, type RoomId } from "@omega/shared";

/** The part of `Storage` we use (`sessionStorage` in the page: this tab only, gone when it closes). */
export interface KickStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const key = (roomId: RoomId): string => `omega.kicked.${roomId}`;

/**
 * When this tab's rejoin cooldown for `roomId` ends (ADR 0030 §2), or null if there's none. A reload inside it shows
 * the notice without reconnecting. The server enforces the cooldown either way; this only saves a doomed join and
 * keeps the wait the notice shows from restarting. Unreadable or implausible records count as no kick.
 */
export function kickedUntil(storage: KickStorage, roomId: RoomId, now: number): number | null {
  try {
    const raw = storage.getItem(key(roomId));
    if (raw === null) return null;
    const until = Number(raw);
    if (Number.isFinite(until) && until > now && until - now <= KICK_COOLDOWN_MS) return until;
    storage.removeItem(key(roomId));
  } catch {
    /* storage disabled: nothing remembered */
  }
  return null;
}

/** We were kicked (4005) at `now`: remember when we may rejoin. A bounce off a running cooldown keeps its end. */
export function rememberKick(storage: KickStorage, roomId: RoomId, now: number): number {
  const until = kickedUntil(storage, roomId, now) ?? now + KICK_COOLDOWN_MS;
  try {
    storage.setItem(key(roomId), String(until));
  } catch {
    /* storage disabled or full: the notice still shows this time */
  }
  return until;
}
