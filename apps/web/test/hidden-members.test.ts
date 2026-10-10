import { describe, expect, test } from "bun:test";
import { HIDDEN_MAX, createHiddenMembers, hiddenKey } from "../src/hide/hidden";

// OME-769 (M9 W3): "Hide for me". Who I hid, keyed by participant id for this room, in this tab only (sessionStorage), so a
// reconnect keeps it and nothing ever leaves the browser.

function memory(): { getItem(k: string): string | null; setItem(k: string, v: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("hidden members", () => {
  test("hide and show one member, per room", () => {
    const s = memory();
    const h = createHiddenMembers(s, "lobby");
    expect(h.has("b")).toBe(false);
    expect(h.set("b", true)).toBe(true);
    expect(h.has("b")).toBe(true);
    expect(h.set("b", true)).toBe(false);
    expect([...h.ids()]).toEqual(["b"]);
    expect(h.set("b", false)).toBe(true);
    expect(h.has("b")).toBe(false);
    expect(h.set("b", false)).toBe(false);
  });

  test("survives a reconnect in the same tab: a new store for the room reads it back; another room doesn't", () => {
    const s = memory();
    createHiddenMembers(s, "lobby").set("b", true);
    expect(createHiddenMembers(s, "lobby").has("b")).toBe(true);
    expect(createHiddenMembers(s, "other").has("b")).toBe(false);
    expect(s.data.get(hiddenKey("lobby"))).toBe(JSON.stringify(["b"]));
  });

  test("a tampered or broken entry is ignored, never trusted", () => {
    for (const bad of ["{", "\"b\"", "[1]", "[\"<img>\"]", JSON.stringify(Array.from({ length: HIDDEN_MAX + 1 }, (_, i) => `m${String(i)}`))]) {
      const s = memory();
      s.setItem(hiddenKey("lobby"), bad);
      expect([...createHiddenMembers(s, "lobby").ids()]).toEqual([]);
    }
  });

  test("blocked storage (getters throw) still hides for this page", () => {
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      },
    };
    const h = createHiddenMembers(blocked, "lobby");
    expect(h.set("b", true)).toBe(true);
    expect(h.has("b")).toBe(true);
  });

  test("never more than HIDDEN_MAX: the oldest hide goes first", () => {
    const h = createHiddenMembers(memory(), "lobby");
    for (let i = 0; i <= HIDDEN_MAX; i++) h.set(`m${String(i)}`, true);
    expect(h.ids().size).toBe(HIDDEN_MAX);
    expect(h.has("m0")).toBe(false);
    expect(h.has(`m${String(HIDDEN_MAX)}`)).toBe(true);
  });
});
