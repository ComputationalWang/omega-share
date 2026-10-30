// Dank Dungeon rework (OME-1977): the v7 sheet holds the new spa and bedroom pieces, the new colours of existing kinds, and the
// panelled shell skin with the room atlas's own rects and anchors; it stays inside its lazy budget (ADR 0056).
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { colorIndex } from "./palette";

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

// Our encoder writes one IDAT with filter 0 on every row, so decoding is inflate + drop the filter bytes (as in watching.test.ts).
function indexed(file: string): (sheetX: number, sheetY: number) => number {
  const png = readFileSync(join(ROOT, file));
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  let o = 8, idat = Buffer.alloc(0);
  while (o < png.length) {
    const len = png.readUInt32BE(o), type = png.toString("latin1", o + 4, o + 8);
    if (type === "IDAT") idat = Buffer.concat([idat, png.subarray(o + 8, o + 8 + len)]);
    o += 12 + len;
  }
  const raw = inflateSync(idat), data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) data.set(raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1)), y * w);
  return (x, y) => data[y * w + x] ?? 0;
}

test("night pane masks (OME-1994): an opaque amber fill of exactly the see-through pane, on the glass back frame's rect and anchor", () => {
  const v7 = atlas("furniture/furniture-v7.json"), v6 = atlas("furniture/furniture-v6.json");
  const px7 = indexed("furniture/furniture-v7.png"), px6 = indexed("furniture/furniture-v6.png");
  const amber = colorIndex("mustard", 1);
  for (const [colour, back, solid, pxBack] of [["glass", v6, v6, px6], ["panelglass", v7, v7, px7]] as const) for (const d of ["se", "sw"]) {
    const m = v7.frames[`furniture/partition/${colour}/pane/${d}`], b = back.frames[`furniture/partition/${colour}/${d}/back`];
    const s = solid.frames[`furniture/partition/${colour === "glass" ? "solid" : "panel"}/${d}/back`];
    if (!m || !b || !s) throw new Error(`${colour}/${d}: missing frame`);
    expect([m.frame.w, m.frame.h, m.anchor.x, m.anchor.y]).toEqual([b.frame.w, b.frame.h, b.anchor.x, b.anchor.y]);
    let filled = 0;
    for (let y = 0; y < m.frame.h; y++) for (let x = 0; x < m.frame.w; x++) {
      const v = px7(m.frame.x + x, m.frame.y + y);
      const behind = pxBack(b.frame.x + x, b.frame.y + y);
      // The same pixel in the solid wall, lined up on the anchor: the pane is what the solid wall fills and the glass leaves open.
      const sx = x - Math.round(b.anchor.x * b.frame.w) + Math.round(s.anchor.x * s.frame.w);
      const sy = y - Math.round(b.anchor.y * b.frame.h) + Math.round(s.anchor.y * s.frame.h);
      const wall = sx >= 0 && sy >= 0 && sx < s.frame.w && sy < s.frame.h ? (colour === "glass" ? px6 : px7)(s.frame.x + sx, s.frame.y + sy) : 0;
      expect(v === 0 || v === amber, `${colour}/${d} (${String(x)},${String(y)})`).toBe(true);
      expect(v === amber, `${colour}/${d} (${String(x)},${String(y)})`).toBe(behind === 0 && wall !== 0);
      if (v === amber) filled++;
    }
    expect(filled).toBeGreaterThan(1000);
  }
});

test("the flat TV has its tray swatch (OME-1994)", () => {
  expect(atlas("ui/edit.json").frames["swatch/flat"]).toBeDefined();
  expect(readFileSync(join(ROOT, "ui", "reference.css"), "utf8")).toContain(".ui-swatch-flat {");
});

test("the sauna and the soaking tub stand on their contract footprint (2×2 from the anchor cell toward +col/+row), back views and fronts alike (OME-1999)", () => {
  // Anchor = the anchor cell's centre; the footprint's cells span u, v ∈ [−8, 24], screen x = 2(u − v), y = u + v. Floor pieces
  // only rise from it, so nothing drawn may stick out past its sides or below its two near edges (1 px for the outline, 5 more for
  // the light the sauna spills under its door onto the next cell).
  const sheets = ["furniture-v7", "furniture-back"].map((n) => ({ a: atlas(`furniture/${n}.json`), px: indexed(`furniture/${n}.png`) }));
  let checked = 0;
  for (const { a, px } of sheets) for (const [key, f] of Object.entries(a.frames)) {
    if (!/^furniture\/(sauna|soaktub)\/cedar\/(se|sw|ne|nw)\//.test(key)) continue;
    const { x: fx, y: fy, w, h } = f.frame, ax = f.anchor.x * w, ay = f.anchor.y * h;
    let worst = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!px(fx + x, fy + y)) continue;
      const sx = x + 0.5 - ax, sy = y + 0.5 - ay;
      worst = Math.max(worst, Math.abs(sx) - 64, sy - (48 - Math.abs(sx) / 2));
    }
    expect(worst, key).toBeLessThanOrEqual(6);
    checked++;
  }
  expect(checked).toBe(8);
});

test("the glass partitions' stripe is a muted sheen, no white glow highlight streaking across the beds behind it (OME-2023)", () => {
  const v7 = atlas("furniture/furniture-v7.json"), v6 = atlas("furniture/furniture-v6.json");
  const px7 = indexed("furniture/furniture-v7.png"), px6 = indexed("furniture/furniture-v6.png");
  const white = colorIndex("glow", 0);
  for (const [colour, sheet, px] of [["glass", v6, px6], ["panelglass", v7, px7]] as const) for (const d of ["se", "sw"]) {
    const b = sheet.frames[`furniture/partition/${colour}/${d}/back`];
    if (!b) throw new Error(`${colour}/${d}: missing frame`);
    let hot = 0;
    for (let y = 0; y < b.frame.h; y++) for (let x = 0; x < b.frame.w; x++) if (px(b.frame.x + x, b.frame.y + y) === white) hot++;
    expect(hot, `${colour}/${d}`).toBe(0);
  }
});
