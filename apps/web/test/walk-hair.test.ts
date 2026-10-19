import { describe, expect, test } from "bun:test";
import { AVATAR_COUNT, HAIR_COUNT } from "@omega/shared";
import { AVATAR_IDS, lookPatch, parseHairs, parseTints, retintPng } from "../src/walk/tint";

// OME-1438 (art OME-1436): a hair colour is the same PLTE swap as a shirt tint, on the avatar's hair slots. hairs.json
// names, per avatar, the 3 slots and 6 ramps; hair 0 is the shipped look. A look is (tint, hair): one patch, one copy.

const hairsJson: unknown = await Bun.file(new URL("../../../assets/avatars/hairs.json", import.meta.url)).json();
const tintsJson: unknown = await Bun.file(new URL("../../../assets/avatars/tints.json", import.meta.url)).json();
const sheet = async (path: string): Promise<Uint8Array> => new Uint8Array(await Bun.file(new URL(`../../../assets/${path}.png`, import.meta.url)).arrayBuffer());

function plte(png: Uint8Array): Uint8Array {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let i = 8; i < png.length; ) {
    const len = dv.getUint32(i);
    if (new TextDecoder().decode(png.subarray(i + 4, i + 8)) === "PLTE") return png.subarray(i + 8, i + 8 + len);
    i += 12 + len;
  }
  throw new Error("no PLTE");
}
const hexAt = (p: Uint8Array, slot: number): string => `#${Array.from(p.subarray(slot * 3, slot * 3 + 3), (b) => b.toString(16).padStart(2, "0")).join("")}`;

describe("parseHairs", () => {
  test("gives every avatar, in avatar order, its 3 hair slots and 6 ramps, named for people", () => {
    const h = parseHairs(hairsJson, AVATAR_IDS);
    expect(h).toHaveLength(AVATAR_COUNT);
    for (const a of h) expect(a.hairs).toHaveLength(HAIR_COUNT);
    expect(h[0]?.slots).toEqual([44, 45, 46]);
    expect(h[1]?.slots).toEqual([71, 72, 73]);
    // `hairDark`, `hairGinger`, `hairPink` are the art's own slot names: the swatch reads "Dark", "Ginger", "Pink".
    expect(h[0]?.hairs.map((r) => r.id)).toEqual(["dark", "ginger", "blonde", "silver", "cherry", "sky"]);
    expect(h[1]?.hairs[0]?.id).toBe("ginger");
    expect(h[3]?.hairs[0]).toEqual({ id: "pink", colors: ["#f7b3c9", "#f08fb1", "#c26080"] });
  });
  test("throws on a missing avatar or a short list", () => {
    expect(() => parseHairs(hairsJson, ["juno", "nobody"])).toThrow();
    const bad = structuredClone(hairsJson) as { avatars: { juno: { hairs: unknown[] } } };
    bad.avatars.juno.hairs.pop();
    expect(() => parseHairs(bad, ["juno"])).toThrow();
  });
});

describe("lookPatch", () => {
  const tints = parseTints(tintsJson, AVATAR_IDS);
  const hairs = parseHairs(hairsJson, AVATAR_IDS);
  test("the shipped look patches nothing", () => {
    expect(lookPatch(tints, hairs, 0, 0, 0)).toEqual({ slots: [], colors: [] });
  });
  test("a tint alone, a hair alone, or both: the slots and colours of each", () => {
    expect(lookPatch(tints, hairs, 0, 1, 0)).toEqual({ slots: [14, 15, 16], colors: ["#6fd0c4", "#3aa7a3", "#23706f"] });
    expect(lookPatch(tints, hairs, 1, 0, 4)).toEqual({ slots: [71, 72, 73], colors: ["#b4f0c0", "#78d098", "#449a6c"] });
    expect(lookPatch(tints, hairs, 0, 1, 2)).toEqual({ slots: [14, 15, 16, 44, 45, 46], colors: ["#6fd0c4", "#3aa7a3", "#23706f", "#fbe7a8", "#e9cd7c", "#b89a52"] });
  });
  test("no avatar, tint or hair by that number: nothing", () => {
    expect(lookPatch(tints, hairs, AVATAR_COUNT, 1, 1)).toEqual({ slots: [], colors: [] });
    expect(lookPatch(tints, hairs, 0, 9, 9)).toEqual({ slots: [], colors: [] });
  });
  test("tint and hair compose in one copy of every body and hat sheet: both ramps land, nothing else moves", async () => {
    const { slots, colors } = lookPatch(tints, hairs, 2, 3, 5);
    for (const path of ["avatars/motion", "accessories/bare", "accessories/accessories", "themes/halloween/halloween"]) {
      const png = await sheet(path);
      const before = plte(png);
      const after = plte(retintPng(png, slots, colors));
      slots.forEach((s, i) => {
        expect(hexAt(after, s)).toBe(colors[i] ?? "");
      });
      for (let s = 0; s < before.length / 3; s++) if (!slots.includes(s)) expect(hexAt(after, s)).toBe(hexAt(before, s));
    }
  });
});
