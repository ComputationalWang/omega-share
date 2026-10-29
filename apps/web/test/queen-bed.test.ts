import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { FACINGS, RoomLayoutSchema, type RoomLayout } from "@omega/shared";
import { coloursOf } from "../src/editor/colours";
import { AWAITING_ART, TRAY_TABS, problems } from "../src/editor/draft";
import { FurnitureManifestSchema, RoomManifestSchema, sceneOf, standDepth, type Scene } from "../src/furniture";
import { cellCenter } from "../src/layout";

// The queen bed (OME-1984; contract OME-1982 / ADR 0057, art OME-1983): a 2×2 piece drawn on its anchor, sorted at its middle, in the tray.

const load = async (path: string): Promise<unknown> => Bun.file(new URL(`../../../assets/${path}`, import.meta.url)).json();
const sheets = await Promise.all(["furniture.json", "furniture-v5.json", "furniture-v6.json", "furniture-v7.json"].map(async (f) => v.parse(FurnitureManifestSchema, await load(`furniture/${f}`))));
const room = v.parse(RoomManifestSchema, await load("room/room.json"));
const edit = v.parse(v.object({ frames: v.record(v.string(), v.unknown()) }), await load("ui/edit.json")).frames;
const preset = v.parse(v.object({ shell: v.optional(v.literal("dungeon")), furniture: v.array(v.unknown()) }), await load("presets/dank-dungeon.json"));
const dungeon: RoomLayout = v.parse(RoomLayoutSchema, { furniture: preset.furniture, ...(preset.shell === undefined ? {} : { shell: preset.shell }) });

const bedAt = (facing: (typeof FACINGS)[number]): RoomLayout => ({ furniture: [{ kind: "tv", col: 0, row: 0, facing: "se" }, { kind: "bed", col: 4, row: 4, facing }] });
const bedSprites = (s: Scene) => s.sprites.filter((x) => x.key.startsWith("furniture/bed/"));

describe("the queen bed in a room", () => {
  test("each facing draws one empty bed frame on the anchor cell, no covers", () => {
    for (const facing of FACINGS) {
      const sprites = bedSprites(sceneOf(bedAt(facing), sheets, room));
      expect(sprites.map((x) => x.key)).toEqual([`furniture/bed/velvet/${facing}/back`]);
      expect(sprites[0]).toMatchObject({ ...cellCenter(4, 4), layer: "object" });
    }
  });

  test("it sorts at its middle: in front of someone behind it, behind someone in front of it", () => {
    for (const facing of FACINGS) {
      const z = bedSprites(sceneOf(bedAt(facing), sheets, room))[0]?.z ?? NaN;
      expect(z).toBeGreaterThan(standDepth(cellCenter(3, 3)));
      expect(z).toBeLessThan(standDepth(cellCenter(6, 6)));
    }
  });

  test("two seats, each sitter drawn over the bed", () => {
    for (const facing of FACINGS) {
      const scene = sceneOf(bedAt(facing), sheets, room);
      const z = bedSprites(scene)[0]?.z ?? NaN;
      expect(scene.seats).toHaveLength(2);
      for (const s of scene.seats) expect(s.z).toBeGreaterThan(z);
    }
  });

  test("the Dank Dungeon preset shows its two queen beds", () => {
    const keys = sceneOf(dungeon, sheets, room).sprites.map((x) => x.key);
    expect(keys).toContain("furniture/bed/velvet/nw/back");
    expect(keys).toContain("furniture/bed/velvet/ne/back");
    expect(problems(dungeon)).toEqual([]);
  });
});

describe("the queen bed in the editor", () => {
  test("it's in the Seats tab, in velvet, with its tray thumbnail", () => {
    expect(AWAITING_ART.has("bed")).toBe(false);
    expect(TRAY_TABS.find((t) => t.id === "seats")?.kinds).toContain("bed");
    expect(coloursOf("bed")).toEqual(sheets[2]?.meta.omega.pieces.find((p) => p.id === "bed")?.colours ?? []);
    expect(coloursOf("bed")).toEqual(["velvet"]);
    expect(edit["thumb/bed/velvet"]).toBeDefined();
  });
});
