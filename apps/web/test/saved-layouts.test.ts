import { describe, expect, test } from "bun:test";
import cafe from "../../../assets/presets/cafe.json";
import cinema from "../../../assets/presets/cinema.json";
import classic from "../../../assets/presets/classic.json";
import living from "../../../assets/presets/living.json";
import lounge from "../../../assets/presets/lounge.json";
import empty from "../../../assets/presets/empty.json";
import { MAX_SAVED_LAYOUTS, SAVED_LAYOUTS_KEY, deleteSavedLayout, loadSavedLayouts, saveLayout, saveMessage } from "../src/saved-layouts";

class MemoryStore {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, value: string): void {
    this.data.set(k, value);
  }
}
const throwing = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: (): void => {
    throw new Error("SecurityError");
  },
};

const A = classic;
const B = cinema;

describe("saved layouts store", () => {
  test("uses the documented key and an empty store reads as none", () => {
    expect(SAVED_LAYOUTS_KEY).toBe("omega.savedLayouts.v1");
    expect(MAX_SAVED_LAYOUTS).toBe(5);
    expect(loadSavedLayouts(new MemoryStore())).toEqual([]);
  });

  test("a saved layout round-trips", () => {
    const s = new MemoryStore();
    expect(saveLayout(s, "  My room ", A)).toEqual({ ok: true, dropped: null });
    expect(loadSavedLayouts(s)).toEqual([{ name: "My room", layout: A }]);
  });

  test("the same name overwrites in place", () => {
    const s = new MemoryStore();
    saveLayout(s, "one", A);
    saveLayout(s, "two", B);
    expect(saveLayout(s, "one", B)).toEqual({ ok: true, dropped: null });
    expect(loadSavedLayouts(s)).toEqual([
      { name: "one", layout: B },
      { name: "two", layout: B },
    ]);
  });

  test("a sixth name drops the oldest and says which", () => {
    const s = new MemoryStore();
    for (const n of ["a", "b", "c", "d", "e"]) saveLayout(s, n, A);
    expect(saveLayout(s, "f", B)).toEqual({ ok: true, dropped: "a" });
    expect(loadSavedLayouts(s).map((x) => x.name)).toEqual(["b", "c", "d", "e", "f"]);
  });

  test("names are trimmed to 1-40 characters; others are refused and nothing is written", () => {
    const s = new MemoryStore();
    expect(saveLayout(s, "   ", A)).toEqual({ ok: false, reason: "name" });
    expect(saveLayout(s, "x".repeat(41), A)).toEqual({ ok: false, reason: "name" });
    expect(saveLayout(s, "x".repeat(40), A)).toEqual({ ok: true, dropped: null });
    expect(saveLayout(s, "bad", { furniture: [] })).toEqual({ ok: false, reason: "layout" });
    expect(loadSavedLayouts(s)).toHaveLength(1);
  });

  test("delete removes by name", () => {
    const s = new MemoryStore();
    saveLayout(s, "a", A);
    saveLayout(s, "b", B);
    deleteSavedLayout(s, "a");
    expect(loadSavedLayouts(s).map((x) => x.name)).toEqual(["b"]);
    deleteSavedLayout(s, "nope");
    expect(loadSavedLayouts(s)).toHaveLength(1);
  });

  test("corrupt JSON, a wrong shape and a throwing storage read as none and never throw", () => {
    const s = new MemoryStore();
    for (const raw of ["not json{", "{}", "42", "null", '"x"', "[1,2]"]) {
      s.data.set(SAVED_LAYOUTS_KEY, raw);
      expect(loadSavedLayouts(s)).toEqual([]);
    }
    expect(loadSavedLayouts(throwing)).toEqual([]);
    expect(saveLayout(throwing, "a", A)).toEqual({ ok: false, reason: "storage" });
    expect(() => {
      deleteSavedLayout(throwing, "a");
    }).not.toThrow();
  });

  test("invalid entries are dropped, valid ones kept, and an over-long array is cut to 5", () => {
    const s = new MemoryStore();
    const good = { name: "ok", layout: A };
    s.data.set(SAVED_LAYOUTS_KEY, JSON.stringify([good, { name: "bad", layout: { furniture: [{ kind: "tv" }] } }, { name: "", layout: A }, { name: "y".repeat(41), layout: A }, { layout: A }]));
    expect(loadSavedLayouts(s)).toEqual([good]);
    const many = [classic, cinema, living, lounge, cafe, empty, classic].map((layout, i) => ({ name: `n${String(i)}`, layout }));
    s.data.set(SAVED_LAYOUTS_KEY, JSON.stringify(many));
    expect(loadSavedLayouts(s).map((x) => x.name)).toEqual(["n0", "n1", "n2", "n3", "n4"]);
  });
});

describe("saveMessage (the editor's status line)", () => {
  test("says what happened, including which layout was dropped", () => {
    expect(saveMessage("Mine", { ok: true, dropped: null })).toBe('Saved "Mine" to your layouts.');
    expect(saveMessage("Mine", { ok: true, dropped: "Old" })).toBe('Saved "Mine" to your layouts. Dropped your oldest, "Old".');
    expect(saveMessage("", { ok: false, reason: "name" })).toBe("Give the layout a name of 1 to 40 characters.");
    expect(saveMessage("Mine", { ok: false, reason: "storage" })).toContain("storage");
    expect(saveMessage("Mine", { ok: false, reason: "layout" })).toContain("isn't a valid");
  });
});
