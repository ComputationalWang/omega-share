// Teleport pad (OME-1546): every colour is a palette remap of the teal one (only the field ramp moves), and the active frame
// differs from the idle one inside the same rect.
import { expect, test } from "bun:test";
import { PIECES, pieceFrames } from "./furniture";
import { colorIndex, type Tone } from "./palette";
import { applyRemap } from "./tints";

const pad = PIECES.find((p) => p.id === "pad");
const same = (a: Uint8Array, b: Uint8Array | undefined): boolean => b !== undefined && Buffer.from(a).equals(Buffer.from(b));

test("lilac is teal with the field ramp remapped, idle and active", () => {
  if (!pad) throw new Error("no pad");
  const remap = new Map(([0, 1, 2] as Tone[]).map((t) => [colorIndex("teal", t), colorIndex("lilac", t)]));
  const teal = pieceFrames(pad, "teal", "ne"), lilac = pieceFrames(pad, "lilac", "ne");
  expect(teal.map((f) => f.key.replace("/teal/", "/lilac/"))).toEqual(lilac.map((f) => f.key));
  teal.forEach((f, i) => { expect(same(applyRemap(f.img, remap), lilac[i]?.img)).toBe(true); });
});

test("the active frame shares the idle rect and anchor but lights up", () => {
  if (!pad) throw new Error("no pad");
  const [idle, active] = pieceFrames(pad, "teal", "ne");
  expect(active?.key).toBe("furniture/pad/teal/use/ne/0");
  expect([active?.w, active?.h, active?.ax, active?.ay]).toEqual([idle?.w, idle?.h, idle?.ax, idle?.ay]);
  expect(same(idle?.img ?? new Uint8Array(), active?.img)).toBe(false);
});
