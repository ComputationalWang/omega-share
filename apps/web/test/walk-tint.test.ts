import { describe, expect, test } from "bun:test";
import { AVATAR_COUNT, TINT_COUNT } from "@omega/shared";
import { AVATAR_IDS, parseTints, retintPng, tintAccent } from "../src/walk/tint";

// OME-1352 (ADR 0053, art OME-1347): a shirt tint is a PLTE swap of the avatar sheets. tints.json names, per avatar,
// the 3 palette slots of its swatch ramp and 6 ramps; tint 0 is the shipped look.

const tintsJson: unknown = await Bun.file(new URL("../../../assets/avatars/tints.json", import.meta.url)).json();
const IDS = ["juno", "pip", "mo", "kiki"] as const;
const sheet = async (name: string): Promise<Uint8Array> => new Uint8Array(await Bun.file(new URL(`../../../assets/avatars/${name}.png`, import.meta.url)).arrayBuffer());

/** Every chunk of a PNG: type, data, and whether its stored CRC matches (checked with Bun's own crc32). */
function chunks(png: Uint8Array): { type: string; data: Uint8Array; crcOk: boolean }[] {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  for (let i = 8; i < png.length; ) {
    const len = dv.getUint32(i);
    const type = new TextDecoder().decode(png.subarray(i + 4, i + 8));
    out.push({ type, data: png.subarray(i + 8, i + 8 + len), crcOk: Bun.hash.crc32(png.subarray(i + 4, i + 8 + len)) === dv.getUint32(i + 8 + len) });
    i += 12 + len;
  }
  return out;
}
const hexAt = (plte: Uint8Array, slot: number): string => `#${Array.from(plte.subarray(slot * 3, slot * 3 + 3), (b) => b.toString(16).padStart(2, "0")).join("")}`;

describe("parseTints", () => {
  test("AVATAR_IDS is avatars.json's avatar order", async () => {
    const avatars = (await Bun.file(new URL("../../../assets/avatars/avatars.json", import.meta.url)).json()) as { meta: { omega: { avatars: { id: string }[] } } };
    expect(AVATAR_IDS).toEqual(avatars.meta.omega.avatars.map((a) => a.id));
  });
  test("gives every avatar, in avatar order, its 3 swatch slots and 6 ramps", () => {
    const t = parseTints(tintsJson, IDS);
    expect(t).toHaveLength(AVATAR_COUNT);
    for (const a of t) {
      expect(a.slots).toHaveLength(3);
      expect(a.tints).toHaveLength(TINT_COUNT);
    }
    expect(t[0]?.slots).toEqual([14, 15, 16]);
    expect(t[0]?.tints[1]).toEqual({ id: "teal", colors: ["#6fd0c4", "#3aa7a3", "#23706f"] });
    expect(t[1]?.tints[0]?.id).toBe("teal");
  });
  test("throws on a missing avatar, a short list or a bad colour", () => {
    expect(() => parseTints(tintsJson, ["juno", "nobody"])).toThrow();
    const bad = structuredClone(tintsJson) as { avatars: { juno: { tints: unknown[]; slots: unknown[] } } };
    bad.avatars.juno.tints.pop();
    expect(() => parseTints(bad, ["juno"])).toThrow();
    const hex = structuredClone(tintsJson) as { avatars: { juno: { tints: { colors: string[] }[] } } };
    const first = hex.avatars.juno.tints[0];
    if (first !== undefined) first.colors[0] = "red";
    expect(() => parseTints(hex, ["juno"])).toThrow();
  });
});

describe("retintPng", () => {
  test("rewrites only the 3 swatch PLTE entries, with a valid CRC, in every sheet", async () => {
    for (const name of ["avatars", "motion", "expressions"]) {
      const png = await sheet(name);
      const out = retintPng(png, [14, 15, 16], ["#6fd0c4", "#3aa7a3", "#23706f"]);
      expect(out).not.toBe(png);
      const before = chunks(png);
      const after = chunks(out);
      expect(after.map((c) => c.type)).toEqual(before.map((c) => c.type));
      expect(after.every((c) => c.crcOk)).toBe(true);
      const plte = after.find((c) => c.type === "PLTE")?.data ?? new Uint8Array();
      const orig = before.find((c) => c.type === "PLTE")?.data ?? new Uint8Array();
      expect([14, 15, 16].map((s) => hexAt(plte, s))).toEqual(["#6fd0c4", "#3aa7a3", "#23706f"]);
      // Every other palette entry and every other chunk byte is untouched.
      for (let s = 0; s < plte.length / 3; s++) if (s < 14 || s > 16) expect(hexAt(plte, s)).toBe(hexAt(orig, s));
      expect(after.find((c) => c.type === "IDAT")?.data).toEqual(before.find((c) => c.type === "IDAT")?.data ?? new Uint8Array());
      // The input is never written to.
      expect(chunks(png).every((c) => c.crcOk)).toBe(true);
      expect(hexAt(orig, 14)).toBe("#f7d36b");
    }
  });
  test("throws on bytes that are not a paletted PNG, or a slot past the palette", async () => {
    const png = await sheet("avatars");
    expect(() => retintPng(new Uint8Array(20), [0, 1, 2], ["#000000", "#000000", "#000000"])).toThrow();
    expect(() => retintPng(png, [200, 201, 202], ["#000000", "#000000", "#000000"])).toThrow();
  });
});

// OME-1375: a member's bubble edge and name tag wear their shirt's colour: the middle of their tint's ramp (the swatch's).
describe("tintAccent", () => {
  const tints = parseTints(tintsJson, IDS);
  test("is the middle colour of that avatar's ramp for that tint, for every avatar and tint", () => {
    for (let a = 0; a < AVATAR_COUNT; a++) {
      for (let t = 0; t < TINT_COUNT; t++) expect(tintAccent(tints, a, t)).toBe(tints[a]?.tints[t]?.colors[1] ?? "missing");
    }
    expect(tintAccent(tints, 0, 1)).toBe("#3aa7a3");
  });

  test("no avatar or tint by that number: null", () => {
    expect(tintAccent(tints, AVATAR_COUNT, 0)).toBeNull();
    expect(tintAccent(tints, 0, TINT_COUNT)).toBeNull();
    expect(tintAccent(tints, -1, 0)).toBeNull();
  });
});
