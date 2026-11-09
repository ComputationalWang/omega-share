import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { RoomLayoutSchema, type Furniture, type RoomLayout } from "@omega/shared";
import { coloursOf } from "../src/editor/colours";
import { AWAITING_ART, TRAY_TABS } from "../src/editor/draft";
import { V8_THUMBS } from "../src/editor/v8-thumbs";
import { FurnitureManifestSchema, RoomManifestSchema, sceneOf, usesSetG, usesV7, usesV8, usesV8Shell, type Scene } from "../src/furniture";
import { rawCenter, setNorth } from "../src/layout";
import { recolourOf } from "../src/recolours";

// OME-2455: the rest of wave 2's v8 set (assets/README.md "Wave 2"): tripod, window, long clock, lava lamp (+ bubbles), v8 colours of
// older kinds, and the penthouse and studio shell skins from furniture-v8-shell.

const load = async (path: string): Promise<unknown> => Bun.file(new URL(`../../../assets/${path}`, import.meta.url)).json();
const parse = async (path: string): Promise<v.InferOutput<typeof FurnitureManifestSchema>> => v.parse(FurnitureManifestSchema, await load(path));
const manifest = await parse("furniture/furniture.json");
const v2 = await parse("furniture/furniture-v2.json");
const v4 = await parse("furniture/furniture-v4.json");
const v7 = await parse("furniture/furniture-v7.json");
const v8 = await parse("furniture/furniture-v8.json");
const v8Shell = await parse("furniture/furniture-v8-shell.json");
const back = await parse("furniture/furniture-back.json");
const room = v.parse(RoomManifestSchema, await load("room/room.json"));
const preset = async (id: string): Promise<RoomLayout> => v.parse(RoomLayoutSchema, v.parse(v.object({ shell: v.string(), furniture: v.array(v.unknown()) }), await load(`presets/${id}.json`)));
const penthouse = await preset("penthouse");
const studio = await preset("studio");

afterEach(() => {
  setNorth(false);
});

const only = (...furniture: Furniture[]): RoomLayout => ({ furniture });
const tripod: Furniture = { kind: "tripod", col: 4, row: 4, facing: "nw" };
const window: Furniture = { kind: "window", col: 0, row: 3, facing: "se" };
const longclock: Furniture = { kind: "longclock", col: 2, row: 2, facing: "sw" };
const lavalamp: Furniture = { kind: "lavalamp", col: 6, row: 6, facing: "se" };
const backOf = (s: Scene, prefix: string): Scene["sprites"][number] | undefined => s.sprites.find((x) => x.key.startsWith(prefix) && x.key.endsWith("/back"));

describe("the four v8 kinds", () => {
  test("load v8, not set (g)", () => {
    for (const f of [tripod, window, longclock, lavalamp]) {
      expect(usesV8(only(f))).toBe(true);
      expect(usesSetG(only(f))).toBe(false);
    }
  });

  test("draw their own frame; window, clock and lamp loop always (ambient), the tripod has no loop", () => {
    const s = sceneOf(only(tripod, window, longclock, lavalamp), [v8]);
    expect(backOf(s, "furniture/tripod/charcoal/nw/")?.use).toBeUndefined();
    for (const [prefix, frames] of [["furniture/window/sky/se/", 4], ["furniture/longclock/wood/sw/", 4], ["furniture/lavalamp/lilac/se/", 4]] as const) {
      const use = backOf(s, prefix)?.use;
      expect(use?.ambient).toBe(true);
      expect(use?.frames).toHaveLength(frames);
      for (const k of use?.frames ?? []) expect(v8.frames[k]).toBeDefined();
    }
  });

  test("the rainy window is variant 1", () => {
    expect(backOf(sceneOf(only({ ...window, variant: 1 }), [v8]), "furniture/window/")?.key).toBe("furniture/window/rain/se/back");
  });
});

describe("v8 colours of older kinds (V8_COLOURS)", () => {
  test("mug, espresso, kitchenette and jukebox load v8; the older colours do not", () => {
    for (const [kind, variant] of [["sidetable", 1], ["barcounter", 1], ["barcounter", 2], ["speaker", 2]] as const) expect(usesV8(only({ kind, col: 3, row: 3, facing: "se", variant }))).toBe(true);
    for (const [kind, variant] of [["sidetable", 0], ["barcounter", 0], ["speaker", 1]] as const) expect(usesV8(only({ kind, col: 3, row: 3, facing: "se", variant }))).toBe(false);
  });

  test("each draws its v8 frame with its ambient loop; the older sheets keep the lower variants", () => {
    const at = (kind: Furniture["kind"], variant: number): Scene["sprites"][number] | undefined => backOf(sceneOf(only({ kind, col: 3, row: 3, facing: "se", variant }), [manifest, v2, v4, v8]), `furniture/${kind}/`);
    expect(at("sidetable", 1)?.key).toBe("furniture/sidetable/mug/se/back");
    expect(at("barcounter", 1)?.key).toBe("furniture/barcounter/espresso/se/back");
    expect(at("barcounter", 2)?.key).toBe("furniture/barcounter/kitchen/se/back");
    expect(at("speaker", 2)?.key).toBe("furniture/speaker/jukebox/se/back");
    expect(at("speaker", 2)?.use?.ambient).toBe(true);
    expect(at("speaker", 1)?.key).toBe("furniture/speaker/teal/se/back");
    expect(at("sidetable", 0)?.key).toBe("furniture/sidetable/wood/se/back");
  });
});

describe("the lava lamp's bubble column (variant 1)", () => {
  test("is a recolour of the v8 lamp, its loop included", () => {
    expect(recolourOf("lavalamp", 1)).toMatchObject({ sheet: "furniture/furniture-v8.png", frames: "furniture/lavalamp/lilac/", id: "bubbles" });
    const s = backOf(sceneOf(only({ ...lavalamp, variant: 1 }), [v8]), "recolour/lavalamp/1/");
    expect(s?.key).toBe("recolour/lavalamp/1/furniture/lavalamp/lilac/se/back");
    expect(s?.use?.ambient).toBe(true);
    expect(s?.use?.frames[3]).toBe("recolour/lavalamp/1/furniture/lavalamp/lilac/use/se/3");
  });
});

describe("the penthouse and studio shell skins (furniture-v8-shell)", () => {
  const shellKeys = (s: Scene): string[] => s.sprites.map((x) => x.key).filter((k) => /^(floor|wall)\//.test(k));
  const keyAt = (s: Scene, x: number, y: number, prefix: string): string | undefined => {
    const p = rawCenter(x, y);
    return s.sprites.find((k) => k.x === p.x && k.y === p.y && k.key.startsWith(prefix) && !k.key.includes("/end/"))?.key;
  };
  const frames = (...ms: { readonly frames: Record<string, unknown> }[]): Set<string> => new Set(ms.flatMap((m) => Object.keys(m.frames)));

  test("both shells load v8-shell and v7; the dungeon does not load v8-shell", () => {
    for (const l of [penthouse, studio]) {
      expect(usesV8Shell(l)).toBe(true);
      expect(usesV7(l)).toBe(true);
    }
    expect(usesV8Shell({ ...penthouse, shell: "dungeon" })).toBe(false);
  });

  test("penthouse: deck and sky behind the row-4 line, the split tiles on it, the room's planks and smoke in front", () => {
    const s = sceneOf(penthouse, [v7, v8Shell], room);
    const all = frames(v7, v8Shell, room);
    for (const k of shellKeys(s)) expect(all.has(k)).toBe(true);
    expect(keyAt(s, 0, 0, "floor/")).toBe("floor/deck/0");
    expect(keyAt(s, 1, 4, "floor/")).toBe("floor/pent/1");
    expect(keyAt(s, 2, 4, "floor/")).toBe("floor/pent/0");
    expect(keyAt(s, 3, 7, "floor/")).toBe(keyAt(sceneOf({ furniture: [] }, [], room), 3, 7, "floor/"));
    expect(keyAt(s, 0, 0, "wall/l/")).toBe("wall/l/sky/0");
    expect(keyAt(s, 0, 1, "wall/l/")).toBe("wall/l/sky/1");
    expect(keyAt(s, 0, 4, "wall/l/")).toBe("wall/l/sky/split");
    expect(keyAt(s, 0, 6, "wall/l/")).toBe("wall/l/smoke");
    expect(keyAt(s, 3, 0, "wall/r/")).toBe("wall/r/sky/1");
    for (const k of ["wall/corner/sky", "wall/l/end/smoke", "wall/r/end/sky"]) expect(shellKeys(s)).toContain(k);
  });

  test("penthouse from the north: the split's north frame, smoke on the right, every key in v7, v8-shell, the back sheet or the room", () => {
    setNorth(true);
    const s = sceneOf(penthouse, [v7, v8Shell], room, back);
    const all = frames(v7, v8Shell, back, room);
    for (const k of shellKeys(s)) expect(all.has(k)).toBe(true);
    expect(keyAt(s, 0, 5, "wall/l/")).toBe("wall/l/sky/split/north");
    expect(keyAt(s, 4, 5, "floor/")).toBe("floor/pent/north/1");
    expect(keyAt(s, 3, 0, "wall/r/")).toBe("wall/r/smoke");
  });

  test("studio: carpet behind, the nook split, planks in front, and the room's papered walls", () => {
    const s = sceneOf(studio, [v7, v8Shell], room);
    expect(keyAt(s, 0, 0, "floor/")).toBe("floor/carpet/0");
    expect(keyAt(s, 2, 4, "floor/")).toBe("floor/nook/0");
    expect(keyAt(s, 3, 7, "floor/")).toBe(keyAt(sceneOf({ furniture: [] }, [], room), 3, 7, "floor/"));
    const walls = (l: RoomLayout): string[] => shellKeys(sceneOf(l, [v7, v8Shell], room)).filter((k) => k.startsWith("wall/"));
    expect(walls(studio)).toEqual(walls({ furniture: studio.furniture }));
  });

  test("without v8-shell (or v7) loaded, both draw today's shell", () => {
    for (const l of [penthouse, studio]) {
      const today = shellKeys(sceneOf({ furniture: l.furniture }, [v7, v8Shell], room));
      expect(shellKeys(sceneOf(l, [v7], room))).toEqual(today);
      expect(shellKeys(sceneOf(l, [v8Shell], room))).toEqual(today);
    }
  });
});

describe("the editor offers the four kinds", () => {
  test("in the tray, with their colours and their se frame from the v8 sheet as tray art", async () => {
    const raw = v.parse(v.object({ frames: v.record(v.string(), v.object({ frame: v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() }) })) }), await load("furniture/furniture-v8.json"));
    const tray = TRAY_TABS.flatMap((t) => [...t.kinds]);
    for (const [kind, colours, facing] of [["tripod", ["charcoal"], "se"], ["window", ["sky", "rain"], "se"], ["longclock", ["wood"], "se"], ["lavalamp", ["lilac", "bubbles"], "se"]] as const) {
      expect(AWAITING_ART.has(kind)).toBe(false);
      expect(tray).toContain(kind);
      expect(coloursOf(kind)).toEqual(colours);
      expect(V8_THUMBS[kind]).toEqual(raw.frames[`furniture/${kind}/${colours[0]}/${facing}/back`]?.frame);
    }
  });
});
