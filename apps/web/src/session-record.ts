import * as v from "valibot";
import { RESUME_STORAGE_KEY_PREFIX, ResumeRecordSchema, type ResumeRecord } from "@omega/shared";

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

export function saveResume(store: ResumeStore, record: ResumeRecord): void {
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

export function handOffResume(_local: ResumeStore, _record: ResumeRecord, _now: number): void {}

export function takeHandOff(_local: ResumeStore, _roomId: string, _now: number): ResumeRecord | null {
  return null;
}
