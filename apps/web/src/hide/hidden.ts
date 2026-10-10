// "Hide for me" (OME-769, M9 W3): who I hid in this room, by participant id. Client-only: it lives in this tab's
// sessionStorage, so a reconnect or a reload keeps it, and nothing about it is ever sent. The stored list is parsed
// like any other outside data; a broken or tampered one is dropped.
import { MemberIdSchema, type MemberId } from "@omega/shared";
import * as v from "valibot";

/** At most this many hidden per room; past it, the oldest hide goes. A room holds far fewer people than this. */
export const HIDDEN_MAX = 64;

export const hiddenKey = (roomId: string): string => `omega.hidden.${roomId}`;

const Stored = v.pipe(v.array(MemberIdSchema), v.maxLength(HIDDEN_MAX));

export interface HiddenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HiddenMembers {
  has(id: MemberId): boolean;
  /** Hide (true) or show (false) `id`; false when it already was. */
  set(id: MemberId, hidden: boolean): boolean;
  /** Oldest hide first. */
  ids(): ReadonlySet<MemberId>;
}

function read(storage: HiddenStore, key: string): MemberId[] {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    const parsed = v.safeParse(Stored, JSON.parse(raw));
    return parsed.success ? parsed.output : [];
  } catch {
    return [];
  }
}

export function createHiddenMembers(storage: HiddenStore, roomId: string): HiddenMembers {
  const key = hiddenKey(roomId);
  const ids = new Set<MemberId>(read(storage, key));
  const save = (): void => {
    try {
      storage.setItem(key, JSON.stringify([...ids]));
    } catch {
      // Storage blocked or full: the hide still holds for this page.
    }
  };
  return {
    has: (id) => ids.has(id),
    set(id, hidden) {
      if (ids.has(id) === hidden) return false;
      if (hidden) {
        ids.add(id);
        for (const old of ids) {
          if (ids.size <= HIDDEN_MAX) break;
          ids.delete(old);
        }
      } else ids.delete(id);
      save();
      return true;
    },
    ids: () => ids,
  };
}
