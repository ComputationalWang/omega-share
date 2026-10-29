// Back views (OME-1997) for the 180° view swap (OME-1961): from the north a viewer sees the far side of every one-sided
// (CAMERA/FIXED) piece in the partitioned Dank Dungeon. They live on one lazy sheet, `furniture/furniture-back`, under the same
// key scheme with the turned facing: se → nw, sw → ne. Symmetric pieces (the oval rug, the plants) need none: their front frame is
// their back.
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BACK_VIEWS } from "./furniture";

const ROOT = join(import.meta.dir, "..");
interface F { frame: { x: number; y: number; w: number; h: number }; anchor: { x: number; y: number } }
const atlas = (file: string): { frames: Record<string, F> } => JSON.parse(readFileSync(join(ROOT, file), "utf8")) as { frames: Record<string, F> };
const TURN: Record<string, string> = { se: "nw", sw: "ne" };

test("covers the Dank Dungeon's one-sided pieces, the flat TV and the projector console included", () => {
  expect(Object.keys(BACK_VIEWS).sort()).toEqual([
    "arclamp/brass", "coffeetable/wood", "desk/wood", "minibar/fridge", "minibar/wood", "partition/glass", "partition/panel",
    "partition/panelglass", "partition/solid", "sauna/cedar", "soaktub/cedar", "tv/charcoal", "tv/flat", "washbasin/cream",
  ]);
});

test("every back view has its frames under the turned facing, with a front layer where the front view has one", () => {
  const back = atlas("furniture/furniture-back.json");
  const fronts = ["furniture.json", "furniture-v2.json", "furniture-v4.json", "furniture-v5.json", "furniture-v6.json", "furniture-v7.json"].map((f) => atlas(`furniture/${f}`));
  for (const [key, dirs] of Object.entries(BACK_VIEWS)) for (const d of dirs) {
    const turned = TURN[d] ?? "";
    expect(back.frames[`furniture/${key}/${turned}/back`], `${key}/${turned}`).toBeDefined();
    if (fronts.some((a) => a.frames[`furniture/${key}/${d}/front`])) expect(back.frames[`furniture/${key}/${turned}/front`], `${key}/${turned}/front`).toBeDefined();
  }
  // Plus the north view's shell skin: the split wall and floor turned round, the corner and ends in the other skin.
  const shell = ["wall/l/split/north", "wall/corner/smoke", "wall/l/end/oak", "wall/r/end/smoke", "floor/split/north/0", "floor/split/north/1"];
  for (const k of shell) expect(back.frames[k], k).toBeDefined();
  expect(Object.keys(back.frames).filter((k) => !shell.includes(k)).every((k) => /^furniture\/[a-z]+\/[a-z]+\/(ne|nw)\/(back|front)$/.test(k))).toBe(true);
});

test("the back sheet stays inside its lazy allowance (≤ 12 KB, ADR 0056)", () => {
  expect(statSync(join(ROOT, "furniture", "furniture-back.png")).size).toBeLessThanOrEqual(12 * 1024);
});
