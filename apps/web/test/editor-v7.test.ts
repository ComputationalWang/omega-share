import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { coloursOf } from "../src/editor/colours";
import { AWAITING_ART, TRAY_TABS } from "../src/editor/draft";

// The v7 pieces in the tray (OME-1991): sauna, soaktub and lounger, the oval carpet, and the flat tv (swatch from OME-1994).

const edit = v.parse(v.object({ frames: v.record(v.string(), v.unknown()) }), await Bun.file(new URL("../../../assets/ui/edit.json", import.meta.url)).json()).frames;
const tray = (): string[] => TRAY_TABS.flatMap((t) => [...t.kinds]);

describe("the tray offers the v7 pieces", () => {
  test("sauna, soaktub and lounger are in it; the older Dank Dungeon kinds still wait", () => {
    for (const k of ["sauna", "soaktub", "lounger"] as const) {
      expect(AWAITING_ART.has(k)).toBe(false);
      expect(tray()).toContain(k);
    }
    expect(AWAITING_ART.has("bed")).toBe(true);
  });

  test("the tv offers the console and the flat screen, each with its swatch and thumb", () => {
    expect(coloursOf("tv")).toEqual(["charcoal", "flat"]);
    for (const c of coloursOf("tv")) expect([edit[`swatch/${c}`], edit[`thumb/tv/${c}`]]).not.toContain(undefined);
  });

  test("their colours and the oval carpet come from v7", () => {
    expect(coloursOf("sauna")).toEqual(["cedar"]);
    expect(coloursOf("soaktub")).toEqual(["cedar"]);
    expect(coloursOf("lounger")).toEqual(["teak"]);
    expect(coloursOf("carpet")).toEqual(["navy", "oval"]);
  });

  test("the edit kit has their tray thumbs and the oval swatch", () => {
    for (const k of ["thumb/sauna/cedar", "thumb/soaktub/cedar", "thumb/lounger/teak", "thumb/carpet/navy", "thumb/carpet/oval", "swatch/oval"]) expect(edit[k]).toBeDefined();
  });
});
