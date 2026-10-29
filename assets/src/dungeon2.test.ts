// Dank Dungeon rework (OME-1977): the v7 sheet holds the new spa and bedroom pieces, the new colours of existing kinds, and the
// panelled shell skin with the room atlas's own rects and anchors; it stays inside its lazy budget (ADR 0056).
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
interface F { frame: { x: number; y: number; w: number; h: number }; anchor: { x: number; y: number } }
interface Piece { id: string; colours: string[]; dirs: string[]; cut?: boolean; seatsByDir?: Record<string, unknown[]>; layersByDir: Record<string, string[]> }
const atlas = (file: string): { frames: Record<string, F>; meta: { omega: { pieces: Piece[] } } } =>
  JSON.parse(readFileSync(join(ROOT, file), "utf8")) as { frames: Record<string, F>; meta: { omega: { pieces: Piece[] } } };

test("v7 lists the new kinds and only the new colours of existing ones", () => {
  const v7 = atlas("furniture/furniture-v7.json");
  const got = Object.fromEntries(v7.meta.omega.pieces.map((p) => [p.id, { colours: p.colours, dirs: p.dirs }]));
  expect(got).toEqual({
    sauna: { colours: ["cedar"], dirs: ["se", "sw"] },
    soaktub: { colours: ["cedar"], dirs: ["se"] },
    lounger: { colours: ["teak"], dirs: ["ne", "nw", "se", "sw"] },
    mirror: { colours: ["silver"], dirs: ["se", "sw"] },
    minibar: { colours: ["fridge"], dirs: ["se", "sw"] },
    tv: { colours: ["flat"], dirs: ["se"] },
    carpet: { colours: ["oval"], dirs: ["se"] },
    partition: { colours: ["panel", "panelglass"], dirs: ["se", "sw"] },
  });
});

test("every v7 piece has its frames: back per facing, front where it seats someone in it, cut stubs for the panelled partition", () => {
  const v7 = atlas("furniture/furniture-v7.json");
  for (const p of v7.meta.omega.pieces) for (const c of p.colours) for (const d of p.dirs) {
    for (const layer of p.layersByDir[d] ?? []) expect(v7.frames[`furniture/${p.id}/${c}/${d}/${layer}`]).toBeDefined();
    if (p.cut) expect(v7.frames[`furniture/${p.id}/${c}/cut/${d}`]).toBeDefined();
  }
  const by = (id: string): Piece | undefined => v7.meta.omega.pieces.find((p) => p.id === id);
  expect(by("soaktub")?.layersByDir["se"]).toEqual(["back", "front"]);
  expect(by("soaktub")?.seatsByDir?.["se"]?.length).toBe(2);
  expect(by("lounger")?.seatsByDir?.["ne"]?.length).toBe(2);
  expect(by("partition")?.cut).toBe(true);
});

test("the shell skin has the room atlas's rects and anchors, so the renderer swaps keys and nothing else", () => {
  const v7 = atlas("furniture/furniture-v7.json");
  const room = atlas("room/room.json");
  const pairs: [string, string][] = [
    ...["oak", "smoke", "split"].map((s): [string, string] => [`wall/l/${s}`, "wall/l/plain"]),
    ...["oak", "smoke"].map((s): [string, string] => [`wall/r/${s}`, "wall/r/plain"]),
    ["wall/corner/oak", "wall/corner"], ["wall/l/end/smoke", "wall/l/end"], ["wall/r/end/oak", "wall/r/end"],
    ...["carpet", "deck", "split"].flatMap((s) => [0, 1].map((n): [string, string] => [`floor/${s}/${String(n)}`, "floor/0"])),
  ];
  for (const [key, like] of pairs) {
    const a = v7.frames[key], b = room.frames[like];
    expect(a, key).toBeDefined();
    expect([a?.frame.w, a?.frame.h, a?.anchor.x, a?.anchor.y]).toEqual([b?.frame.w, b?.frame.h, b?.anchor.x, b?.anchor.y]);
  }
});

test("v7 stays inside its lazy budget (ADR 0056: ≈21 KB)", () => {
  expect(statSync(join(ROOT, "furniture", "furniture-v7.png")).size).toBeLessThanOrEqual(21 * 1024);
});
