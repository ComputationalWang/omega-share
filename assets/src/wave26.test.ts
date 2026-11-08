// Rooms wave 26 (OME-2440): the v9 sheet's pieces and partition loops, the tunnel's two layers, the two-deep stage's loop on its
// still's anchor (the useFrames gap), and the lava lamp's `bubbles` recolour.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFurniture } from "./furniture";
import { recoloursTable } from "./recolours";
import { DEFS, LOOP, buildWave26Sheets } from "./wave26";

const ROOT = join(import.meta.dir, "..");
const sheets = buildWave26Sheets();
const byKey = new Map(sheets.frames.map((f) => [f.key, f]));
const same = (a: string, b: string): boolean => {
  const x = byKey.get(a), y = byKey.get(b);
  return y !== undefined && x?.w === y.w && x.h === y.h && x.ax === y.ax && x.ay === y.ay && Buffer.from(x.img).equals(Buffer.from(y.img));
};

test("a two-deep piece's loop sits on its still's anchor: the stage's first loop frame is its still, pixel for pixel", () => {
  const stage = DEFS.find((d) => d.id === "stage");
  if (!stage) throw new Error("no stage");
  const { frames } = buildFurniture([stage]);
  const at = new Map(frames.map((f) => [f.key, f]));
  for (const dir of ["se", "sw"]) {
    const still = at.get(`furniture/stage/boards/${dir}/back`), first = at.get(`furniture/stage/boards/use/${dir}/0`);
    expect(first?.img).toEqual(still?.img);
    expect([first?.ax, first?.ay]).toEqual([still?.ax, still?.ay]);
  }
});

test("v9 lists the three new kinds and the four new partition colours, every one looping on the ambient clock", () => {
  const got = Object.fromEntries(sheets.pieces.map((p) => [p.id, { colours: p.colours, use: p.use, ambient: p.ambient }]));
  expect(got).toEqual({
    stage: { colours: ["boards"], use: LOOP, ambient: true },
    vanity: { colours: ["bulbs"], use: LOOP, ambient: true },
    rack: { colours: ["costumes"], use: undefined, ambient: undefined },
    partition: { colours: ["velvet", "wings", "tank", "tunnel"], use: LOOP, ambient: true },
  });
  expect(LOOP.ms % 150).toBe(0); // whole ticks of AMBIENT_TICK_MS
  expect(LOOP.frames).toBeGreaterThanOrEqual(3);
});

test("every partition colour has its still and LOOP's frames in both facings; the water moves in at least 3 distinct frames", () => {
  for (const colour of ["velvet", "wings", "tank", "tunnel"]) {
    for (const dir of ["se", "sw"]) {
      expect(byKey.has(`furniture/partition/${colour}/${dir}/back`)).toBe(true);
      const loop = Array.from({ length: LOOP.frames }, (_, n) => `furniture/partition/${colour}/use/${dir}/${String(n)}`);
      for (const k of loop) expect(byKey.has(k)).toBe(true);
      expect(same(loop[0] ?? "", `furniture/partition/${colour}/${dir}/back`)).toBe(true);
      const distinct = loop.filter((k, i) => loop.findIndex((j) => same(j, k)) === i).length;
      expect(distinct).toBe(colour === "tank" || colour === "tunnel" ? LOOP.frames : 1);
    }
  }
});

test("the tunnel ships a front layer (its near ribs) on the back's rect; no other colour does", () => {
  expect(sheets.pieces.find((p) => p.id === "partition")?.frontColours).toEqual(["tunnel"]);
  for (const dir of ["se", "sw"]) {
    const back = byKey.get(`furniture/partition/tunnel/${dir}/back`), front = byKey.get(`furniture/partition/tunnel/${dir}/front`);
    expect(front?.img.some((v) => v !== 0)).toBe(true);
    expect([front?.w, front?.h, front?.ax, front?.ay]).toEqual([back?.w, back?.h, back?.ax, back?.ay]);
  }
  expect(sheets.frames.filter((f) => f.key.endsWith("/front")).map((f) => f.key).sort()).toEqual(["furniture/partition/tunnel/se/front", "furniture/partition/tunnel/sw/front"]);
});

test("the stage and the vanity ship their turned views for the swap", () => {
  for (const k of ["stage/boards/nw", "stage/boards/ne", "vanity/bulbs/nw", "vanity/bulbs/ne"]) expect(byKey.has(`furniture/${k}/back`)).toBe(true);
});

test("the lava lamp's bubbles is variant 1, a PLTE swap on the v8 sheet listed in v9's meta; recolours.json is left alone", () => {
  const read = (f: string): unknown => JSON.parse(readFileSync(join(ROOT, f), "utf8"));
  const v9 = read("furniture/furniture-v9.json") as { meta: { omega: { recolours?: Record<string, { sheet: string; frames: string; variants: { variant: number; id: string }[] }> } } };
  const lamp = v9.meta.omega.recolours?.["lavalamp"];
  expect(lamp?.sheet).toBe("furniture/furniture-v8.png");
  expect(lamp?.frames).toBe("furniture/lavalamp/lilac/");
  expect(lamp?.variants.map((v) => [v.variant, v.id])).toEqual([[1, "bubbles"]]);
  // The web's recolours.json schema lists the sheets it swaps; a v8 entry there would fail its parse (CI, PR #997).
  const table = recoloursTable() as { kinds: Record<string, unknown> };
  expect(Object.keys(table.kinds)).not.toContain("lavalamp");
  expect(read("furniture/recolours.json")).toEqual(JSON.parse(JSON.stringify(table)));
});
