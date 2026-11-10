// Set (n): the shipped room presets are valid layouts (the same strict schema an owner's `layout-set` meets), and their
// thumbnails exist, have the manifest's size and stay inside the 48 KiB budget (OME-906, OME-2439).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { DOOR_CELL, RoomLayoutInputSchema, SEAT_COUNT, footprintCells, isScreen, layoutSeats } from "@omega/shared";
import { REEF, STAGE_DOOR } from "../../packages/shared/test/wave26-layouts";
import { PRESETS } from "./presets";

const DIR = join(import.meta.dir, "..", "presets");
const Manifest = v.strictObject({
  version: v.literal(1),
  license: v.literal("CC-BY-SA-4.0"),
  default: v.string(),
  thumb: v.strictObject({ w: v.number(), h: v.number(), scale: v.number() }),
  presets: v.array(v.strictObject({ id: v.pipe(v.string(), v.regex(/^[a-z-]{1,12}$/)), name: v.string(), blurb: v.pipe(v.string(), v.maxLength(60)), layout: v.string(), thumb: v.string() })),
});
const manifest = v.parse(Manifest, JSON.parse(readFileSync(join(DIR, "presets.json"), "utf8")));
/** Wave 26 (OME-2441): the room behind the partition line, its seats looking at the line (Stage Door col 4, Reef row 4). */
const BACK_ROOM: Readonly<Record<string, (s: { col: number; row: number }) => boolean>> = { "stage-door": (s) => s.col < 4, reef: (s) => s.row < 4 };
const pngSize = (buf: Buffer): { w: number; h: number } => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

describe("room presets", () => {
  test("five to twelve, unique ids, the default among them", () => {
    expect(manifest.presets.length).toBeGreaterThanOrEqual(5);
    expect(manifest.presets.length).toBeLessThanOrEqual(12);
    const ids = manifest.presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(manifest.default);
  });

  for (const entry of manifest.presets) {
    test(`${entry.id}: the layout file passes RoomLayoutInputSchema and matches presets.ts`, () => {
      const layout: unknown = JSON.parse(readFileSync(join(DIR, entry.layout), "utf8"));
      const parsed = v.safeParse(RoomLayoutInputSchema, layout);
      expect(parsed.issues?.map((i) => i.message) ?? []).toEqual([]);
      if (!parsed.success) return;
      expect(layoutSeats(parsed.output)).toHaveLength(SEAT_COUNT);
      // Every seat looks toward the TV corner, but wave 26's back rooms, which face their partition (tested below).
      const back = BACK_ROOM[entry.id] ?? (() => false);
      expect(layoutSeats(parsed.output).filter((s) => !back(s)).every((s) => s.facing === "ne" || s.facing === "nw")).toBe(true);
      expect(layout).toEqual(PRESETS.find((p) => p.id === entry.id)?.layout);
    });
  }

  test("one preset shows off at least three catalogue v3 pieces (OME-1351)", () => {
    const v3 = ["coffeetable", "pouf", "neonsign", "aquarium", "arcade", "wallclock"];
    const most = Math.max(...PRESETS.map((p) => new Set(p.layout.furniture.map((f) => f.kind).filter((k) => v3.includes(k))).size));
    expect(most).toBeGreaterThanOrEqual(3);
  });

  test("the Bar preset shows off at least four batch 6 pieces (OME-1439)", () => {
    const batch6 = ["hammock", "stool", "barcounter", "piano", "fireplace"];
    const bar = PRESETS.find((p) => p.id === "bar");
    expect(bar?.name).toBe("Bar");
    expect(new Set(bar?.layout.furniture.map((f) => f.kind).filter((k) => batch6.includes(k))).size).toBeGreaterThanOrEqual(4);
  });

  test("Dank Dungeon (OME-1672): night mood, pair emote on, the README's blurb; no other preset has pairs", () => {
    const dd = PRESETS.find((p) => p.id === "dank-dungeon");
    expect(dd?.name).toBe("Dank Dungeon");
    expect(dd?.blurb).toBe("Twin beds, a whirlpool for two, lights down.");
    expect(dd?.layout.mood).toBe("night");
    expect(dd?.layout.pairs).toBe(true);
    expect(PRESETS.filter((p) => p.layout.pairs === true).map((p) => p.id)).toEqual(["dank-dungeon"]);
    // OME-1989: the dungeon shell skin, on this preset only; wave 2's swap rooms wear their own (OME-2071).
    expect(PRESETS.filter((p) => p.layout.shell !== undefined).map((p) => [p.id, p.layout.shell])).toEqual([["dank-dungeon", "dungeon"], ["penthouse", "penthouse"], ["studio", "studio"], ["stage-door", "stage-door"], ["reef", "reef"]]);
  });

  // OME-2071 (ADR 0058): the wave 2 rooms. Four revamps hang a wall screen and drop the TV table, the lounge pulls a screen down;
  // the swap rooms are split on OME-1959's grid (partition on row 4, doorway at (1, 4)) with the screen in the front room.
  test("wave 2: every room has one screen, on the wall in the revamps and swap rooms", () => {
    const screens = Object.fromEntries(PRESETS.map((p) => [p.id, p.layout.furniture.filter((f) => isScreen(f.kind)).map((f) => f.kind)]));
    expect(screens).toEqual({
      classic: ["wallscreen"], cinema: ["bigscreen"], living: ["wallscreen"], lounge: ["projector"], cafe: ["wallscreen"], bar: ["wallscreen"],
      empty: ["tv"], "dank-dungeon": ["tv"], penthouse: ["wallscreen"], studio: ["wallscreen"], "stage-door": ["projector"], reef: ["wallscreen"],
    });
  });

  // OME-2441: wave 26's rooms ship the contract's layouts (OME-2439, the wingback at (2, 5) as the judged art has it, OME-2440).
  test("wave 26: Stage Door and Reef Tunnel are the contract's layouts, the back room's seats facing the partition", () => {
    const byId = (id: string) => PRESETS.find((p) => p.id === id);
    expect([byId("stage-door")?.name, byId("stage-door")?.blurb]).toEqual(["Stage Door", "A club stage in front, the green room behind the wings."]);
    expect([byId("reef")?.name, byId("reef")?.blurb]).toEqual(["Reef Tunnel", "A reef bar, and a tunnel through the tanks to the deep."]);
    expect(byId("stage-door")?.layout).toEqual({ ...STAGE_DOOR, furniture: [...STAGE_DOOR.furniture] });
    expect(byId("reef")?.layout).toEqual({ ...REEF, furniture: [...REEF.furniture] });
    const facings = (id: string, back: boolean) => [...new Set(layoutSeats(byId(id)?.layout ?? { furniture: [] }).filter((s) => (BACK_ROOM[id]?.(s) ?? false) === back).map((s) => s.facing))].sort();
    expect([facings("stage-door", true), facings("reef", true)]).toEqual([["se"], ["sw"]]);
    expect([facings("stage-door", false), facings("reef", false)]).toEqual([["ne"], ["nw"]]);
  });

  for (const id of ["penthouse", "studio"]) {
    test(`${id} (OME-2071): split on row 4 with a doorway at (1, 4), the screen in front, nothing on the way in`, () => {
      const f = PRESETS.find((p) => p.id === id)?.layout.furniture ?? [];
      expect(f.filter((x) => x.kind === "partition").map((w) => [w.col, w.row, w.facing])).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => [c, 4, "sw"]));
      expect(f.find((x) => x.kind === "wallscreen")?.row).toBeGreaterThan(4);
      const keep = new Set([[1, 3], [1, 4], [1, 5], [DOOR_CELL.x, DOOR_CELL.y]].map(([c, r]) => `${String(c)},${String(r)}`));
      expect(f.flatMap((x) => footprintCells(x).filter(([c, r]) => keep.has(`${String(c)},${String(r)}`)).map(() => x.kind))).toEqual([]);
    });
  }

  test("Dank Dungeon (OME-1960): two rooms split by row 4, solid and glass with a doorway at (1, 4); beds behind, the spa in front", () => {
    const f = PRESETS.find((p) => p.id === "dank-dungeon")?.layout.furniture ?? [];
    const walls = f.filter((x) => x.kind === "partition");
    expect(walls.every((w) => w.row === 4 && w.facing === "sw")).toBe(true);
    expect(walls.map((w) => [w.col, w.variant ?? 0]).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))).toEqual([[0, 0], [2, 0], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1]]);
    expect(f.filter((x) => x.kind === "bed").map((b) => [b.col, b.row, b.facing])).toEqual([[2, 2, "nw"], [5, 2, "nw"]]);
    for (const k of ["whirlpool", "washbasin", "mirror"]) expect(f.find((x) => x.kind === k)?.row).toBeGreaterThan(4);
  });

  test("Dank Dungeon (OME-2039): nothing stands on the way in, the doorway's cells or the room's door cell", () => {
    const f = PRESETS.find((p) => p.id === "dank-dungeon")?.layout.furniture ?? [];
    // The doorway at (1, 4) and the cells either side of it; DOOR_CELL is where people walk in.
    const keep = new Set([[1, 3], [1, 4], [1, 5], [DOOR_CELL.x, DOOR_CELL.y]].map(([c, r]) => `${String(c)},${String(r)}`));
    expect(f.flatMap((x) => footprintCells(x).filter(([c, r]) => keep.has(`${String(c)},${String(r)}`)).map(() => x.kind))).toEqual([]);
  });

  test("Dank Dungeon (OME-2039): every chair faces the beds, one from beside the glass", () => {
    const f = PRESETS.find((p) => p.id === "dank-dungeon")?.layout.furniture ?? [];
    const beds = f.filter((x) => x.kind === "bed").flatMap(footprintCells);
    const ahead = { nw: [-1, 0], ne: [0, -1], se: [1, 0], sw: [0, 1] } as const;
    const chairs = f.filter((x) => x.kind === "wingback");
    expect(chairs.length).toBeGreaterThanOrEqual(2);
    for (const c of chairs) {
      // A chair faces the beds when a bed cell lies straight ahead of it (its row or col, in its facing's direction).
      const [dc, dr] = ahead[c.facing];
      const facesBed = beds.some(([bc, br]) => (dc === 0 ? bc === c.col && (br - c.row) * dr > 0 : br === c.row && (bc - c.col) * dc > 0));
      expect([c.col, c.row, c.facing, facesBed]).toEqual([c.col, c.row, c.facing, true]);
    }
    // Beside the glass (cols 3–9 on row 4), on the spa side, looking in.
    expect(chairs.some((c) => c.row === 5 && c.col >= 3 && c.facing === "ne")).toBe(true);
  });

  // OME-2480: OME-2471's judged concepts. Classic hangs the screen and keeps three loops (no mugs: they don't animate and
  // crowd the front chairs); the Theatre's screen stands on risers, the rows one cell further back.
  test("OME-2480: Classic and the Theatre are OME-2471's layouts, eight seats each", () => {
    const byId = (id: string) => PRESETS.find((p) => p.id === id)?.layout.furniture ?? [];
    const at = (f: readonly { kind: string; col: number; row: number }[], kinds: readonly string[]) => f.filter((x) => kinds.includes(x.kind)).map((x) => [x.kind, x.col, x.row]);
    expect(at(byId("classic"), ["tv", "wallscreen", "lavalamp", "window", "longclock", "sidetable"])).toEqual([["wallscreen", 0, 0], ["lavalamp", 0, 0], ["window", 3, 0], ["longclock", 7, 0]]);
    expect(at(byId("cinema"), ["stage", "curtain", "theatrerow"])).toEqual([["stage", 2, 0], ["stage", 0, 2], ["curtain", 1, 0], ["curtain", 0, 1], ["theatrerow", 3, 5], ["theatrerow", 5, 3], ["theatrerow", 4, 7], ["theatrerow", 7, 4]]);
    for (const id of ["classic", "cinema"]) expect(layoutSeats(v.parse(RoomLayoutInputSchema, PRESETS.find((p) => p.id === id)?.layout)).length).toBe(SEAT_COUNT);
  });

  // OME-2497 (judge, OME-2495): the Theatre's rows stand clear of the risers, not even corner to corner; Classic dresses its bare
  // right wall and front-right edge with pieces from sheets it already loads, off the fixture segments, and keeps three loops.
  test("OME-2497: no Theatre row touches a riser cell, corners included", () => {
    const f = PRESETS.find((p) => p.id === "cinema")?.layout.furniture ?? [];
    const riser = new Set(f.filter((x) => x.kind === "stage").flatMap(footprintCells).map(([c, r]) => `${String(c)},${String(r)}`));
    const touching = f.filter((x) => x.kind === "theatrerow").filter((x) => footprintCells(x).some(([c, r]) => [-1, 0, 1].some((dc) => [-1, 0, 1].some((dr) => riser.has(`${String(c + dc)},${String(r + dr)}`)))));
    expect(touching.map((x) => [x.col, x.row])).toEqual([]);
  });

  test("OME-2497: Classic adds a bookshelf on the right wall and a monstera on the front-right edge, off seats and fixture segments", () => {
    const f = PRESETS.find((p) => p.id === "classic")?.layout.furniture ?? [];
    expect(f.filter((x) => x.kind === "bookshelf" || x.kind === "monstera").map((x) => [x.kind, x.col, x.row, x.facing])).toEqual([["bookshelf", 1, 0, "sw"], ["monstera", 9, 2, "sw"]]);
    // presets.ts: nothing on the window / poster / sconce segments (5, 6, 8) of the right wall, even wall-backed pieces.
    expect(f.filter((x) => x.row === 0 && x.facing === "sw").flatMap(footprintCells).filter(([c]) => [5, 6, 8].includes(c))).toEqual([]);
  });

  test("thumbnails: one per preset at the manifest size, ≤ 48 KiB together, no strays", () => {
    let bytes = 0;
    for (const thumb of manifest.presets.map((p) => p.thumb)) {
      const buf = readFileSync(join(DIR, thumb));
      expect(pngSize(buf)).toEqual({ w: manifest.thumb.w, h: manifest.thumb.h });
      bytes += buf.length;
    }
    expect(bytes).toBeLessThanOrEqual(48 * 1024);
    const files = readdirSync(join(DIR, "thumbs")).sort();
    expect(files).toEqual(manifest.presets.map((p) => p.thumb).map((t) => t.replace("thumbs/", "")).sort());
  });
});
