import { describe, expect, test } from "bun:test";
import { RESUME_GRACE_MS, RESUME_STORAGE_KEY_PREFIX, type ResumeRecord } from "@omega/shared";
import { REJOIN_CHIP_MS, clearResume, handOffResume, loadResume, saveResume, stashLeft, takeHandOff, takeLeft, type ResumeStore } from "../src/session-record";

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
    expect(() => {
      saveResume(s, record);
    }).not.toThrow();
    expect(() => {
      clearResume(s, "lobby");
    }).not.toThrow();
  });
});

// A closed tab hands its session to the next tab that opens the room, within the grace window (OME-2075).
describe("hand-off", () => {
  const T = 1_000_000;

  test("the next boot of the room takes it once", () => {
    const local = memStore();
    handOffResume(local, record, T);
    expect(takeHandOff(local, "other", T)).toBeNull();
    expect(takeHandOff(local, "lobby", T + 1000)).toEqual(record);
    expect(local.data.size).toBe(0);
    expect(takeHandOff(local, "lobby", T + 1000)).toBeNull();
  });

  test("past the grace window it is dropped, not used", () => {
    const local = memStore();
    handOffResume(local, record, T);
    expect(takeHandOff(local, "lobby", T + RESUME_GRACE_MS)).toBeNull();
    expect(local.data.size).toBe(0);
  });

  test("garbage, a foreign room and extra keys are dropped", () => {
    const k = "omega.handoff.lobby";
    for (const raw of ["{x", "null", JSON.stringify({ record: { ...record, roomId: "other" }, until: T + 1 }), JSON.stringify({ record, until: T + 1, extra: 1 }), JSON.stringify({ record: { ...record, token: "x" }, until: T + 1 })]) {
      const local = memStore();
      local.setItem(k, raw);
      expect(takeHandOff(local, "lobby", T)).toBeNull();
      expect(local.data.size).toBe(0);
    }
  });

  test("a throwing store degrades to null and no-ops", () => {
    const boom = (): never => {
      throw new Error("denied");
    };
    const s: ResumeStore = { getItem: boom, setItem: boom, removeItem: boom };
    expect(() => {
      handOffResume(s, record, T);
    }).not.toThrow();
    expect(takeHandOff(s, "lobby", T)).toBeNull();
  });
});

// The Leave key hands the session to the landing for a few seconds, for its Rejoin chip (OME-2105).
describe("left", () => {
  const T = 1_000_000;

  test("the landing takes it once, with the room's title, until the chip's time is up", () => {
    const s = memStore();
    stashLeft(s, record, "Film night", T);
    expect(takeLeft(s, T + 1000)).toEqual({ record, title: "Film night", until: T + REJOIN_CHIP_MS });
    expect(s.data.size).toBe(0);
    expect(takeLeft(s, T + 1000)).toBeNull();
  });

  test("an untitled room keeps a null title", () => {
    const s = memStore();
    stashLeft(s, record, null, T);
    expect(takeLeft(s, T)?.title).toBeNull();
  });

  test("past the chip's time it is dropped, not used", () => {
    const s = memStore();
    stashLeft(s, record, "Film night", T);
    expect(takeLeft(s, T + REJOIN_CHIP_MS)).toBeNull();
    expect(s.data.size).toBe(0);
  });

  test("garbage, a bad record and extra keys are dropped", () => {
    for (const raw of ["{x", "null", JSON.stringify({ record: { ...record, token: "x" }, title: null, until: T + 1 }), JSON.stringify({ record, title: null, until: T + 1, extra: 1 }), JSON.stringify({ record, title: 5, until: T + 1 })]) {
      const s = memStore();
      s.setItem("omega.left", raw);
      expect(takeLeft(s, T)).toBeNull();
      expect(s.data.size).toBe(0);
    }
  });

  test("a throwing store degrades to null and no-ops", () => {
    const boom = (): never => {
      throw new Error("denied");
    };
    const s: ResumeStore = { getItem: boom, setItem: boom, removeItem: boom };
    expect(() => {
      stashLeft(s, record, null, T);
    }).not.toThrow();
    expect(takeLeft(s, T)).toBeNull();
  });
});
