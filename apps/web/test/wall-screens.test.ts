import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, FLOOR_CELLS, type Furniture, type RoomLayout } from "@omega/shared";
import { atlasId, coloursOf } from "../src/editor/colours";
import { AWAITING_ART, TRAY_TABS, fits, place, problems, remove } from "../src/editor/draft";
import { markerKeys } from "../src/editor/pick";
import { V8_THUMBS, trayScale } from "../src/editor/v8-thumbs";
import { FurnitureManifestSchema, sceneOf, standDepth, usesSetG, usesV8, type Scene } from "../src/furniture";
import { cellCenter, rawCenter, setNorth } from "../src/layout";

// OME-2069: the wall screen (span 2) and the pull-down screen (span 3), from furniture-v8 (assets/README.md "Wave 2").

const load = async (path: string): Promise<unknown> => Bun.file(new URL(`../../../assets/${path}`, import.meta.url)).json();
const v8 = v.parse(FurnitureManifestSchema, await load("furniture/furniture-v8.json"));
const v8Raw = v.parse(v.object({ frames: v.record(v.string(), v.object({ frame: v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() }) })) }), await load("furniture/furniture-v8.json"));

afterEach(() => {
  setNorth(false);
});

const withWall = (...wall: Furniture[]): RoomLayout => ({ furniture: [...DEFAULT_LAYOUT.furniture.filter((f) => f.kind !== "tv"), ...wall] });
const wallscreen: Furniture = { kind: "wallscreen", col: 0, row: 2, facing: "se" };
const projector: Furniture = { kind: "projector", col: 2, row: 0, facing: "sw" };
const wallSprites = (s: Scene): Scene["sprites"] => s.sprites.filter((x) => x.layer === "wall");

describe("v8 loads when a layout needs it", () => {
  test("a layout with a wall screen uses v8, not set (g); the default layout does not", () => {
    expect(usesV8(withWall(wallscreen))).toBe(true);
    expect(usesV8(withWall(projector))).toBe(true);
    expect(usesV8(DEFAULT_LAYOUT)).toBe(false);
    expect(usesSetG(withWall(wallscreen))).toBe(usesSetG({ furniture: DEFAULT_LAYOUT.furniture.filter((f) => f.kind !== "tv") }));
  });
});

describe("the south view", () => {
  test("each screen hangs at its anchor segment, with its own facing's frame", () => {
    const s = sceneOf(withWall(wallscreen, projector), [v8]);
    expect(wallSprites(s).map((x) => [x.key, x.x, x.y, x.alpha])).toEqual([
      ["furniture/wallscreen/panel/se/back", cellCenter(0, 2).x, cellCenter(0, 2).y, undefined],
      ["furniture/projector/cloth/sw/back", cellCenter(2, 0).x, cellCenter(2, 0).y, undefined],
    ]);
  });
});

describe("the north view (swapped-view rule)", () => {
  test("a screen turns to segment 9 - s - (n - 1) on the near wall, as a half-alpha back frame", () => {
    setNorth(true);
    const s = sceneOf(withWall(wallscreen, projector), [v8]);
    // se, segment 2, span 2 -> col 9, segment 6; sw, segment 2, span 3 -> row 9, segment 5.
    expect(s.sprites.filter((x) => x.alpha === 0.5).map((x) => [x.key, x.x, x.y, x.alpha])).toEqual([
      ["furniture/wallscreen/panel/nw/back", rawCenter(9, 6).x, rawCenter(9, 6).y, 0.5],
      ["furniture/projector/cloth/ne/back", rawCenter(5, 9).x, rawCenter(5, 9).y, 0.5],
    ]);
  });

  test("the ghost sorts above every piece and any avatar in the room, so the front row cannot hide it (QA OME-2091)", () => {
    setNorth(true);
    const s = sceneOf(withWall(wallscreen, projector), [v8]);
    const ghosts = s.sprites.filter((x) => x.alpha === 0.5);
    const others = s.sprites.filter((x) => x.alpha !== 0.5).map((x) => x.z);
    const floor = Array.from({ length: FLOOR_CELLS * FLOOR_CELLS }, (_, i) => standDepth(rawCenter(i % FLOOR_CELLS, Math.floor(i / FLOOR_CELLS))));
    expect(ghosts).toHaveLength(2);
    // The wall layer is drawn under every object (room-view.ts), whatever its z: the ghost sorts with the objects.
    for (const g of ghosts) expect(g.layer).toBe("object");
    for (const g of ghosts) expect(g.z).toBeGreaterThan(Math.max(...others, ...floor, ...s.seats.map((x) => x.z)));
  });

  test("other wall pieces are still dropped from the north", () => {
    setNorth(true);
    const s = sceneOf(withWall({ kind: "frame", col: 1, row: 0, facing: "sw" }), [v8]);
    expect(wallSprites(s)).toEqual([]);
  });
});

describe("the editor offers them", () => {
  test("they are in the tray with their se frame from the v8 sheet, no thumb frame needed (OME-2095)", () => {
    for (const k of ["wallscreen", "projector"] as const) {
      expect(AWAITING_ART.has(k)).toBe(false);
      expect(TRAY_TABS.flatMap((t) => [...t.kinds])).toContain(k);
    }
    expect(coloursOf("wallscreen")).toEqual(["panel"]);
    expect(coloursOf("projector")).toEqual(["cloth"]);
    const rect = (key: string): { x: number; y: number; w: number; h: number } | undefined => v8Raw.frames[key]?.frame;
    expect([V8_THUMBS["wallscreen"], V8_THUMBS["projector"]]).toEqual([rect("furniture/wallscreen/panel/se/back"), rect("furniture/projector/cloth/se/back")]);
  });

  test("every tray kind with a colour has an edit.png thumb or an se fallback (OME-2095)", async () => {
    const edit = v.parse(v.object({ frames: v.record(v.string(), v.unknown()) }), await load("ui/edit.json")).frames;
    const bare = TRAY_TABS.flatMap((t) => [...t.kinds]).filter((k) => {
      const c = coloursOf(k)[0];
      return c !== undefined && edit[`thumb/${atlasId(k) ?? k}/${c}`] === undefined && V8_THUMBS[k] === undefined;
    });
    expect(bare).toEqual([]);
  });

  test("the se frame is scaled by 1/n, n >= 2, to fit the 44x40 cubby (OME-2095)", () => {
    expect(trayScale({ w: 62, h: 70 })).toBe(2);
    expect(trayScale({ w: 76, h: 119 })).toBe(3);
    expect(trayScale({ w: 20, h: 10 })).toBe(2);
    expect(trayScale({ w: 100, h: 30 })).toBe(3);
    for (const r of Object.values(V8_THUMBS)) {
      const n = trayScale(r);
      expect(r.w / n).toBeLessThanOrEqual(44);
      expect(r.h / n).toBeLessThanOrEqual(40);
    }
  });

  test("a placement marks every segment it covers", () => {
    expect(markerKeys(wallscreen, "ok")).toEqual([
      { key: "place/ok/wall-se", col: 0, row: 2 },
      { key: "place/ok/wall-se", col: 0, row: 3 },
    ]);
    expect(markerKeys(projector, "no").map((m) => [m.key, m.col, m.row])).toEqual([2, 3, 4].map((c) => ["place/no/wall-sw", c, 0]));
    expect(markerKeys({ kind: "wallscreen", col: 0, row: FLOOR_CELLS - 1, facing: "se" }, "no")).toHaveLength(1);
  });

  test("fixture segments and the far end are invalid, and a span collides on every segment", () => {
    const base = withWall(wallscreen);
    for (const row of [4, 5, 7, 8, 9]) expect(fits(withWall(), { ...wallscreen, row })).toBe(false);
    expect(fits(withWall(), { ...wallscreen, row: 0 })).toBe(true);
    expect(fits(base, { kind: "frame", col: 0, row: 3, facing: "se" })).toBe(false);
    expect(fits(base, { ...wallscreen, row: 3 })).toBe(false);
    expect(fits(base, { kind: "frame", col: 0, row: 4, facing: "se" })).toBe(true);
  });

  test("one screen per room: a wall screen swaps in for the tv, not beside it", () => {
    expect(problems({ furniture: [...DEFAULT_LAYOUT.furniture, wallscreen] })).toContainEqual({ code: "tv", have: 2 });
    const swapped = place(remove(DEFAULT_LAYOUT, 0), wallscreen);
    expect(swapped).not.toBeNull();
    expect(swapped === null ? ["no layout"] : problems(swapped)).toEqual([]);
  });
});
