import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { FURNITURE, RoomLayoutSchema, type RoomLayout } from "@omega/shared";
import { FurnitureManifestSchema, RoomManifestSchema, sceneOf, type Scene } from "../src/furniture";
import { recolourOf, recolourSource, recoloursIn } from "../src/recolours";
import { coloursOf } from "../src/editor/colours";
import { TRAY_TABS, VARIANTS_AWAITING_ART } from "../src/editor/draft";
import { cellCenter } from "../src/layout";

// The 2 extra colours of six pieces (OME-1463, art OME-1462: assets/furniture/recolours.json, a runtime PLTE swap).

const json = async (path: string): Promise<unknown> => Bun.file(new URL(`../../../assets/${path}`, import.meta.url)).json();
const manifest = v.parse(FurnitureManifestSchema, await json("furniture/furniture.json"));
const v2 = v.parse(FurnitureManifestSchema, await json("furniture/furniture-v2.json"));
const v4 = v.parse(FurnitureManifestSchema, await json("furniture/furniture-v4.json"));
const room = v.parse(RoomManifestSchema, await json("room/room.json"));
const edit = v.parse(v.object({ frames: v.record(v.string(), v.unknown()) }), await json("ui/edit.json")).frames;
const FRAMES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "furniture/furniture.png": manifest.frames,
  "furniture/furniture-v2.png": v2.frames,
  "furniture/furniture-v4.png": v4.frames,
  "room/room.png": room.frames,
};

/** A room in every new colour, and one old piece in a shipped colour. */
const NEW: RoomLayout = v.parse(RoomLayoutSchema, {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "rug", col: 1, row: 1, facing: "se", variant: 1 },
    { kind: "sofa", col: 2, row: 8, facing: "ne", variant: 2 },
    { kind: "beanbag", col: 9, row: 9, facing: "nw", variant: 3 },
    { kind: "pouf", col: 8, row: 0, facing: "sw", variant: 2 },
    { kind: "stool", col: 9, row: 2, facing: "sw", variant: 3 },
    { kind: "runner", col: 7, row: 8, facing: "ne", variant: 2 },
    { kind: "wingback", col: 0, row: 5, facing: "ne" },
    { kind: "sofa", col: 5, row: 8, facing: "ne", variant: 1 },
  ],
});
const keysOf = (s: Scene): string[] => s.sprites.map((x) => x.key);

describe("the scene draws a new colour from its recoloured copy", () => {
  const scene = sceneOf(NEW, [manifest, v2, v4], room);

  test("a recoloured piece's frames are the source colour's, under its kind and variant", () => {
    expect(keysOf(scene)).toContain("recolour/sofa/2/furniture/sofa/velvet/ne/back");
    expect(keysOf(scene)).toContain("recolour/beanbag/3/furniture/beanbag/blush/nw/back");
    expect(keysOf(scene)).toContain("recolour/pouf/2/furniture/pouf/rust/sw/back");
    // The stool's swap is of its padded teal seat, not the shipped default (wood).
    expect(keysOf(scene)).toContain("recolour/stool/3/furniture/stool/teal/sw/back");
    expect(keysOf(scene)).toContain("recolour/runner/2/furniture/rug/lilac/ne/back");
    expect(scene.sprites.find((x) => x.key === "recolour/sofa/2/furniture/sofa/velvet/ne/back")).toMatchObject(cellCenter(2, 8));
  });

  test("the room's rug draws all 49 tiles from its copy; the planks around it don't", () => {
    const rug = scene.sprites.filter((x) => x.key.startsWith("recolour/rug/1/rug/"));
    expect(rug).toHaveLength(49);
    expect(keysOf(scene).some((k) => k.startsWith("rug/"))).toBe(false);
    expect(keysOf(scene).filter((k) => k.startsWith("floor/"))).toHaveLength(51);
  });

  test("the room's lamp and plant draw from their copy (OME-1706)", () => {
    const lit = v.parse(RoomLayoutSchema, {
      furniture: [...NEW.furniture, { kind: "lamp", col: 9, row: 0, facing: "se", variant: 1 }, { kind: "plant", col: 0, row: 9, facing: "se", variant: 2 }],
    });
    const keys = keysOf(sceneOf(lit, [manifest, v2, v4], room));
    expect(keys).toContain("recolour/lamp/1/lamp/0");
    expect(keys).toContain("recolour/plant/2/plant/0");
    expect(keys).not.toContain("lamp/0");
    expect(keys).not.toContain("plant/0");
    for (const k of ["lamp/0", "plant/0"]) expect(room.frames[k]).toBeDefined();
  });

  test("a shipped colour is drawn as before", () => {
    expect(keysOf(scene)).toContain("furniture/sofa/navy/ne/back");
    const old = sceneOf({ furniture: NEW.furniture.map(({ kind, col, row, facing }) => ({ kind, col, row, facing })) }, [manifest, v2, v4], room);
    expect(keysOf(old).some((k) => k.startsWith("recolour/"))).toBe(false);
  });

  test("every recoloured sprite names a frame of the sheet its swap is for", () => {
    const keys = scene.sprites.flatMap((x) => [x.key, ...(x.use?.frames ?? [])]).filter((k) => k.startsWith("recolour/"));
    expect(keys.length).toBeGreaterThan(49);
    for (const k of keys) {
      const src = recolourSource(k);
      const r = src === null ? undefined : recolourOf(src.kind, src.variant);
      expect(r).toBeDefined();
      expect(src?.key.startsWith(r?.frames ?? "?")).toBe(true);
      expect(FRAMES[r?.sheet ?? ""]?.[src?.key ?? ""]).toBeDefined();
    }
  });

  test("not a key of ours: no source", () => {
    expect(recolourSource("furniture/sofa/velvet/ne/back")).toBeNull();
    expect(recolourSource("recolour/sofa/9/furniture/sofa/velvet/ne/back")).toBeNull();
    expect(recolourSource("recolour/nope/2/x")).toBeNull();
  });
});

describe("recoloursIn: the copies a layout needs", () => {
  test("each new colour in use once, shipped ones never", () => {
    const twice: RoomLayout = { furniture: [...NEW.furniture, { kind: "sofa", col: 7, row: 6, facing: "ne", variant: 2 }] };
    expect(recoloursIn(twice)).toEqual([
      { kind: "rug", variant: 1 },
      { kind: "sofa", variant: 2 },
      { kind: "beanbag", variant: 3 },
      { kind: "pouf", variant: 2 },
      { kind: "stool", variant: 3 },
      { kind: "runner", variant: 2 },
    ]);
    expect(recoloursIn({ furniture: NEW.furniture.filter((f) => f.variant === undefined || f.variant < 2).filter((f) => f.kind !== "rug") })).toEqual([]);
  });
});

describe("the editor offers every variant", () => {
  test("the six pieces list their shipped colours, then the new ones", () => {
    expect(coloursOf("sofa")).toEqual(["velvet", "navy", "teal", "ginger"]);
    expect(coloursOf("rug")).toEqual(["navy", "rust", "teal"]);
    expect(coloursOf("stool")).toEqual(["wood", "teal", "lilac", "mustard"]);
    expect(coloursOf("runner")).toEqual(["lilac", "teal", "rust", "mustard"]);
  });

  test("every kind the tray offers with variants has one swatch per variant; the recoloured kinds' are frames of the edit kit", () => {
    for (const kind of TRAY_TABS.flatMap((t) => t.kinds)) {
      if (FURNITURE[kind].variants > 1 && !VARIANTS_AWAITING_ART.has(kind)) expect(coloursOf(kind)).toHaveLength(FURNITURE[kind].variants);
    }
    for (const kind of ["sofa", "rug", "beanbag", "pouf", "stool", "runner", "frame", "garland", "pad", "lamp", "plant", "arclamp", "monstera", "bookshelf", "wallshelf"] as const) {
      for (const c of coloursOf(kind)) expect(edit[`swatch/${c}`]).toBeDefined();
    }
  });
});

describe("the wall pieces' new colours (OME-1503, art OME-1500)", () => {
  const WALL: RoomLayout = v.parse(RoomLayoutSchema, {
    furniture: [
      ...NEW.furniture,
      { kind: "frame", col: 2, row: 0, facing: "sw", variant: 2 },
      { kind: "garland", col: 0, row: 2, facing: "se", variant: 3 },
      { kind: "frame", col: 3, row: 0, facing: "sw", variant: 1 },
    ],
  });
  const scene = sceneOf(WALL, [manifest, v2, v4], room);

  test("a meadow frame and a peach garland draw from their recoloured copies", () => {
    expect(keysOf(scene).some((k) => k.startsWith("recolour/frame/2/furniture/frame/dusk/"))).toBe(true);
    expect(keysOf(scene).some((k) => k.startsWith("recolour/garland/3/furniture/garland/warm/"))).toBe(true);
    for (const k of keysOf(scene).filter((x) => x.startsWith("recolour/"))) {
      const src = recolourSource(k);
      const r = src === null ? undefined : recolourOf(src.kind, src.variant);
      expect(FRAMES[r?.sheet ?? ""]?.[src?.key ?? ""]).toBeDefined();
    }
    expect(recoloursIn(WALL).filter((x) => x.kind === "frame" || x.kind === "garland")).toEqual([
      { kind: "frame", variant: 2 },
      { kind: "garland", variant: 3 },
    ]);
  });

  test("the editor lists their shipped colours, then meadow and sunset, frost and peach", () => {
    expect(coloursOf("frame").slice(2)).toEqual(["meadow", "sunset"]);
    expect(coloursOf("garland").slice(2)).toEqual(["frost", "peach"]);
  });
});
