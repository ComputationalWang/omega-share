import { describe, expect, test } from "bun:test";
import { OUTFIT_SLOTS, readOutfits, saveOutfit } from "../src/outfits/outfits";

// OME-1453: three outfit slots in localStorage, parsed at read; anything bad is ignored.

const KEY = "omega.outfits";
const store = (init: Record<string, string> = {}) => {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const fit = { avatar: 2, tint: 3, hair: 1, accessory: 4 };

describe("readOutfits", () => {
  test("nothing saved: three empty slots", () => {
    expect(OUTFIT_SLOTS).toBe(3);
    expect(readOutfits(store())).toEqual([null, null, null]);
  });

  test("a saved outfit comes back in its slot", () => {
    expect(readOutfits(store({ [KEY]: JSON.stringify([null, fit, null]) }))).toEqual([null, fit, null]);
  });

  test("a bad slot is ignored, the good ones kept", () => {
    const bad = [{ ...fit, tint: 99 }, fit, { avatar: 1 }];
    expect(readOutfits(store({ [KEY]: JSON.stringify(bad) }))).toEqual([null, fit, null]);
    expect(readOutfits(store({ [KEY]: JSON.stringify(["x", 7, { ...fit, avatar: -1 }]) }))).toEqual([null, null, null]);
  });

  test("not JSON, not an array, or a throwing store: three empty slots", () => {
    expect(readOutfits(store({ [KEY]: "{oops" }))).toEqual([null, null, null]);
    expect(readOutfits(store({ [KEY]: JSON.stringify(fit) }))).toEqual([null, null, null]);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
    expect(readOutfits(blocked)).toEqual([null, null, null]);
  });

  test("extra entries past three are dropped", () => {
    expect(readOutfits(store({ [KEY]: JSON.stringify([fit, fit, fit, fit]) }))).toEqual([fit, fit, fit]);
  });
});

describe("saveOutfit", () => {
  test("writes one slot and keeps the others", () => {
    const s = store({ [KEY]: JSON.stringify([fit, null, null]) });
    const other = { avatar: 0, tint: 0, hair: 5, accessory: 0 };
    expect(saveOutfit(s, 2, other)).toBe(true);
    expect(readOutfits(s)).toEqual([fit, null, other]);
  });

  test("a store that throws: false, nothing breaks", () => {
    const full = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(saveOutfit(full, 0, fit)).toBe(false);
  });
});
