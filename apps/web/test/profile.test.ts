import { describe, expect, test } from "bun:test";
import { loadProfile, saveProfile, saveTint, validateNickname, type KeyValueStore } from "../src/profile";

function memory(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("validateNickname", () => {
  test("accepts and trims a valid nickname", () => {
    expect(validateNickname("  Ana B ")).toEqual({ ok: true, nickname: "Ana B" });
  });
  test("rejects empty, too long and emoji nicknames with a message", () => {
    for (const bad of ["", "   ", "x".repeat(21), "hi😀"]) {
      const r = validateNickname(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe("profile storage", () => {
  test("round-trips a saved nickname and avatar", () => {
    const store = memory();
    expect(saveProfile(store, { nickname: "zoe", avatar: 2 })).toBe(true);
    expect(loadProfile(store)).toEqual({ nickname: "zoe", avatar: 2, tint: 0 });
  });
  test("an empty store gives no nickname and avatar 0", () => {
    expect(loadProfile(memory())).toEqual({ nickname: null, avatar: 0, tint: 0 });
  });
  test("tampered stored values are ignored", () => {
    const store = memory({ "omega.nickname": "<script>😀", "omega.avatar": "99" });
    expect(loadProfile(store)).toEqual({ nickname: null, avatar: 0, tint: 0 });
  });
  test("round-trips a shirt tint (ADR 0053), kept apart from the nickname and avatar", () => {
    const store = memory({ "omega.nickname": "zoe", "omega.avatar": "1" });
    expect(saveTint(store, 4)).toBe(true);
    expect(loadProfile(store)).toEqual({ nickname: "zoe", avatar: 1, tint: 4 });
  });
  test("a tampered tint reads as 0", () => {
    for (const bad of ["6", "-1", "2.5", "x"]) expect(loadProfile(memory({ "omega.tint": bad })).tint).toBe(0);
    expect(saveTint(throwing, 2)).toBe(false);
  });
  test("a storage that throws is survivable", () => {
    expect(loadProfile(throwing)).toEqual({ nickname: null, avatar: 0, tint: 0 });
    expect(saveProfile(throwing, { nickname: "zoe", avatar: 1 })).toBe(false);
  });
});
