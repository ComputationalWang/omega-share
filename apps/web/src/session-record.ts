import * as v from "valibot";
import { RESUME_GRACE_MS, RESUME_STORAGE_KEY_PREFIX, ROOM_TITLE_MAX_LENGTH, ResumeRecordSchema, type ResumeRecord } from "@omega/shared";

/** The part of `Storage` we use. Every access may throw (blocked storage), so all of it is guarded. */
export interface ResumeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyFor = (roomId: string): string => RESUME_STORAGE_KEY_PREFIX + roomId;

/** The stored record for this room, or null. A corrupt or foreign record is removed. Never logs the token. */
export function loadResume(store: ResumeStore, roomId: string): ResumeRecord | null {
  try {
    const raw = store.getItem(keyFor(roomId));
    if (raw === null) return null;
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    const parsed = v.safeParse(ResumeRecordSchema, json);
    if (parsed.success && parsed.output.roomId === roomId) return parsed.output;
    store.removeItem(keyFor(roomId));
  } catch {
    // Storage unavailable: behave as if there were no record.
  }
  return null;
}

export function saveResume(store: Pick<ResumeStore, "setItem">, record: ResumeRecord): void {
  try {
    store.setItem(keyFor(record.roomId), JSON.stringify(record));
  } catch {
    // Best effort: without storage the session simply won't survive a reload.
  }
}

export function clearResume(store: ResumeStore, roomId: string): void {
  try {
    store.removeItem(keyFor(roomId));
  } catch {
    // Nothing to clear.
  }
}

// A closing tab's session, handed to the next tab that opens the room (OME-2075). sessionStorage ends with the tab while
// the server still holds the member for the grace window; localStorage bridges that gap. It is written on pagehide and
// taken (removed) by the room's next boot, so a tab still in the room never shares it with a new one.
const handOffKey = (roomId: string): string => `omega.handoff.${roomId}`;
const HandOffSchema = v.strictObject({ record: ResumeRecordSchema, until: v.number() });

export function handOffResume(local: ResumeStore, record: ResumeRecord, now: number): void {
  try {
    local.setItem(handOffKey(record.roomId), JSON.stringify({ record, until: now + RESUME_GRACE_MS }));
  } catch {
    // Best effort: without it a reopened tab gets the ordinary Enter form.
  }
}

/** The handed-off record for this room while its grace window lasts, else null. Always removes it. Never throws. */
export function takeHandOff(local: ResumeStore, roomId: string, now: number): ResumeRecord | null {
  try {
    const raw = local.getItem(handOffKey(roomId));
    if (raw === null) return null;
    local.removeItem(handOffKey(roomId));
    const parsed = v.safeParse(HandOffSchema, JSON.parse(raw));
    return parsed.success && parsed.output.record.roomId === roomId && now < parsed.output.until ? parsed.output.record : null;
  } catch {
    return null;
  }
}

// The room's creator goes straight in with the saved profile, without a second entry form (OME-2075).
const pendingEnterKey = (roomId: string): string => `omega.pendingEnter.${roomId}`;

export function stashPendingEnter(store: Pick<ResumeStore, "setItem">, roomId: string): void {
  try {
    store.setItem(pendingEnterKey(roomId), "1");
  } catch {
    // Blocked storage: the room page shows the entry form as before.
  }
}

/** True once after a stash for this room. Never throws. */
export function takePendingEnter(store: Pick<ResumeStore, "getItem" | "removeItem">, roomId: string): boolean {
  try {
    if (store.getItem(pendingEnterKey(roomId)) === null) return false;
    store.removeItem(pendingEnterKey(roomId));
    return true;
  } catch {
    return false;
  }
}

// The Leave key's session, handed to the landing for its Rejoin chip (OME-2105, ADR 0043 amendment 3). sessionStorage: the
// same tab goes to `/`. The landing takes (removes) it at boot, so it never outlives the chip.
const LEFT_KEY = "omega.left";
export const REJOIN_CHIP_MS = 10_000;
const LeftSchema = v.strictObject({ record: ResumeRecordSchema, title: v.nullable(v.pipe(v.string(), v.maxLength(ROOM_TITLE_MAX_LENGTH))), until: v.number() });
export type Left = v.InferOutput<typeof LeftSchema>;

export function stashLeft(store: Pick<ResumeStore, "setItem">, record: ResumeRecord, title: string | null, now: number): void {
  try {
    store.setItem(LEFT_KEY, JSON.stringify({ record, title, until: now + REJOIN_CHIP_MS }));
  } catch {
    // Best effort: without it the landing shows no chip.
  }
}

/** The left record while the chip's time lasts, else null. Always removes it. Never throws. */
export function takeLeft(store: Pick<ResumeStore, "getItem" | "removeItem">, now: number): Left | null {
  try {
    const raw = store.getItem(LEFT_KEY);
    if (raw === null) return null;
    store.removeItem(LEFT_KEY);
    const parsed = v.safeParse(LeftSchema, JSON.parse(raw));
    return parsed.success && now < parsed.output.until ? parsed.output : null;
  } catch {
    return null;
  }
}
