// The touch window's home (OME-1930, OME-1843 follow-up): phones and touch tablets kept the seats' home, so whoever stood
// at the front (everyone who just joined) sat at or under the window's foot. It looks at the audience as the band does,
// and keeps my own standing avatar whole, head to name tag, where the window holds it. The page wiring is
// e2e/touch-home.e2e.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema, type RoomLayout } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { AVATAR_TOP, TAG_FOOT, TAG_OFFSET_Y, bandHome, panTo, tagRect, touchHome, type Point } from "../src/layout";

const DIR = new URL("../../../assets/presets/", import.meta.url);
const preset = (file: string): RoomLayout => v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL(file, DIR), "utf8")));
const PRESETS = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "presets.json");
const TAG_H = 20;

// The touch room windows as measured (OME-1930, CSS px = stage px at 1×), without and with a video, less the zoom keys'
// band (room-window.ts `set`: a 52 px column beside a window at least 148 px tall, else the 148 px keys row beside it).
const WINDOWS: readonly (readonly [string, number, number])[] = [
  ["320×640", 268, 225], ["320×640 video", 268, 191],
  ["360×780", 308, 286], ["360×780 video", 308, 252],
  ["844×390 t", 392, 120], ["844×390 t video", 488, 148],
  ["1024×768 t", 620, 270], ["1024×768 t video", 620, 240],
];

function view(l: RoomLayout, me: Point | null, w: number, h: number) {
  return panTo({ w, h }, touchHome(seatPoints(l), standingPoints(l), me, { w, h }));
}

describe("the touch window's home (OME-1930)", () => {
  test("bundled presets found", () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of PRESETS) {
    test.each(WINDOWS)(`${file}, %s: on joining my avatar and its widest name tag are whole in the window`, (_, w, h) => {
      const l = preset(file);
      const me = standingPoints(l)[0];
      if (me === undefined) throw new Error("no standing spot");
      const pan = view(l, me, w, h);
      const tag = tagRect(me);
      expect(me.y - AVATAR_TOP).toBeGreaterThanOrEqual(pan.y);
      expect(me.y + TAG_FOOT).toBeLessThanOrEqual(pan.y + h);
      expect(tag.x).toBeGreaterThanOrEqual(pan.x);
      expect(tag.x + tag.w).toBeLessThanOrEqual(pan.x + w);
    });
  }

  test.each([["1024×768 t", 620, 240], ["768×1024 t", 716, 294]] as const)("Theatre with a video at %s: the front row's four name tags are whole", (_, w, h) => {
    const l = preset("cinema.json");
    const front = standingPoints(l).slice(0, 4);
    const pan = view(l, front[0] ?? null, w, h);
    for (const p of front) {
      expect(p.y + TAG_OFFSET_Y).toBeGreaterThanOrEqual(pan.y);
      expect(p.y + TAG_OFFSET_Y + TAG_H).toBeLessThanOrEqual(pan.y + h);
      expect(p.x).toBeGreaterThanOrEqual(pan.x);
      expect(p.x).toBeLessThanOrEqual(pan.x + w);
    }
  });

  test("not standing (seated, or not in the room): the band's home", () => {
    const l = preset("cinema.json");
    expect(touchHome(seatPoints(l), standingPoints(l), null, { w: 392, h: 120 })).toEqual(bandHome(seatPoints(l), standingPoints(l), 120));
  });
});
