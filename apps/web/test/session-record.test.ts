import { describe, expect, test } from "bun:test";
import { RESUME_STORAGE_KEY_PREFIX, type ResumeRecord } from "@omega/shared";
import { clearResume, loadResume, saveResume, type ResumeStore } from "../src/session-record";

function memStore(): ResumeStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, val) => void data.set(k, val),
    removeItem: (k) => void data.delete(k),
  };
}

const record: ResumeRecord = { roomId: "lobby", token: "A".repeat(43), nickname: "zoe", avatar: 1 };
const key = `${RESUME_STORAGE_KEY_PREFIX}lobby`;

describe("session-record", () => {
  test("round trips under the per-room key", () => {
    const s = memStore();
    saveResume(s, record);
    expect(s.data.has(key)).toBe(true);
    expect(loadResume(s, "lobby")).toEqual(record);
  });

  test("nothing stored loads null", () => {
    expect(loadResume(memStore(), "lobby")).toBeNull();
  });

  test("a record for another room is removed and ignored", () => {
    const s = memStore();
    s.setItem(key, JSON.stringify({ ...record, roomId: "other" }));
    expect(loadResume(s, "lobby")).toBeNull();
    expect(s.data.has(key)).toBe(false);
  });

  test("unknown keys, a bad token and garbage are rejected and removed", () => {
    for (const raw of [JSON.stringify({ ...record, extra: 1 }), JSON.stringify({ ...record, token: "short" }), "{not json", "null"]) {
      const s = memStore();
      s.setItem(key, raw);
      expect(loadResume(s, "lobby")).toBeNull();
      expect(s.data.has(key)).toBe(false);
    }
  });

  test("clearResume removes only that room", () => {
    const s = memStore();
    saveResume(s, record);
    saveResume(s, { ...record, roomId: "other" });
    clearResume(s, "lobby");
    expect(loadResume(s, "lobby")).toBeNull();
    expect(loadResume(s, "other")).not.toBeNull();
  });

  test("a throwing store degrades to null and no-ops", () => {
    const boom = (): never => {
      throw new Error("denied");
    };
    const s: ResumeStore = { getItem: boom, setItem: boom, removeItem: boom };
    expect(loadResume(s, "lobby")).toBeNull();
    expect(() => saveResume(s, record)).not.toThrow();
    expect(() => clearResume(s, "lobby")).not.toThrow();
  });
});
