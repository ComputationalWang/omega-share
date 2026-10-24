// The audience band (OME-1843, design OME-1799 §2 m1/m2): with a video the room is a band under the hero TV (OME-1803) at
// 1× or 2× (OME-1811). It spans the left column's width, and it looks at the audience, the seats and the standing spots,
// not the room's middle: every front-row name tag shows whole. The page wiring is e2e/wide-layout.e2e.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { ROOM_VIEW, TAG_FOOT, TAG_OFFSET_Y, chromeZoom, roomScale, seatsHome, wheelView, wideLayout, type Point } from "../src/layout";

const cinema = v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL("../../../assets/presets/cinema.json", import.meta.url), "utf8")));
/** Where members are: a seat, or a standing spot (stage.ts hands both to the room window). */
const AUDIENCE: readonly Point[] = [...seatPoints(cinema), ...standingPoints(cinema)];
const TAG_H = 20;

// [window, column width, column height]: the left column as measured (the TV-hero runs, OME-1803/OME-1840), People shut and open.
const VIEWPORTS: readonly (readonly [number, number, number, number])[] = [
  [1280, 800, 936, 613],
  [1920, 1080, 1416, 828],
  [1920, 1080, 1176, 828],
  [2560, 1440, 1896, 1118],
  [2560, 1440, 1808, 1118],
];

/** The band's view as the room window opens it: centred on the audience's home, kept on the room (room-window.ts deskHome). */
function bandView(w: number, h: number, vw: number, vh: number) {
  const l = wideLayout(w, h, "youtube", chromeZoom(vw, vh), roomScale(vw, vh));
  const k = l.scale;
  const c = seatsHome(AUDIENCE, l.stage.h / k, TAG_FOOT);
  const view = wheelView(k, { zoom: 1, pan: { x: c.x - l.stage.w / (2 * k), y: c.y - l.stage.h / (2 * k) } }, { x: 0, y: 0 }, 1, l.stage);
  return { l, k, pan: view.pan, shown: { w: l.stage.w / k, h: l.stage.h / k } };
}

describe("the audience band (OME-1843)", () => {
  test.each(VIEWPORTS)("%p×%p, a %p×%p column with a video: the room at 1× or 2×, centred in the column, so its bleed reaches both edges", (vw, vh, w, h) => {
    const { l } = bandView(w, h, vw, vh);
    expect([1, 2]).toContain(l.scale);
    expect(l.stage.w).toBe(Math.min(w, ROOM_VIEW.w * l.scale));
    // room-layout.ts bleeds the band ceil((w - stage.w) / 2) px each side.
    expect(l.stage.x).toBe(Math.floor((w - l.stage.w) / 2));
    expect(l.stage.x + l.stage.w + Math.ceil((w - l.stage.w) / 2)).toBeGreaterThanOrEqual(w);
    expect(l.stage.y).toBeGreaterThanOrEqual(l.controls.y + l.controls.h);
    expect(l.stage.y + l.stage.h).toBeLessThanOrEqual(h);
  });

  test.each(VIEWPORTS)("%p×%p, a %p×%p column: every seat's and standing spot's name tag is whole in the band", (vw, vh, w, h) => {
    const { pan, shown } = bandView(w, h, vw, vh);
    for (const p of AUDIENCE) {
      expect(p.y + TAG_OFFSET_Y).toBeGreaterThanOrEqual(pan.y);
      expect(p.y + TAG_OFFSET_Y + TAG_H).toBeLessThanOrEqual(pan.y + shown.h);
      expect(p.x).toBeGreaterThanOrEqual(pan.x);
      expect(p.x).toBeLessThanOrEqual(pan.x + shown.w);
    }
  });

  // AC 3: 2× needs the band to hold the audience at 2× (2 × 240 px); the hero TV (≥ 45 % of the window, OME-1803) leaves
  // 2560×1440 a 313 px band, so 2× would crop the seated rows: it's 1×, and the band's bleed still spans the column.
  test("2560×1440 with a video stays 1× (the hero leaves 313 px; the audience needs 2 × 240); empty, 2×", () => {
    expect(wideLayout(1808, 1118, "youtube", 2, 2).scale).toBe(1);
    expect(wideLayout(1808, 1118, null, 2, 2).scale).toBe(2);
  });
});

describe("where the band looks (seatsHome)", () => {
  test("a band too short for everyone keeps the front row's name tags whole, a pixel to spare", () => {
    const front = Math.max(...AUDIENCE.map((p) => p.y));
    for (const h of [120, 200, 240]) expect(seatsHome(AUDIENCE, h, TAG_FOOT).y + h / 2).toBe(front + TAG_OFFSET_Y + TAG_H + 1);
  });
});

describe("the band's bleed (room.css)", () => {
  test("clipped to the column's edges, top and bottom at the band's; the dim's spread fills it", async () => {
    const css = await Bun.file(new URL("../src/room.css", import.meta.url)).text();
    expect(css).toMatch(/\.stage-clip\.is-bleed \{ overflow: visible; clip-path: inset\(0 calc\(-1 \* var\(--bleed\)\)\); \}/);
    expect(css).toMatch(/\.cinema-dim\.is-on \{[^}]*box-shadow: 0 0 0 100vmax rgb\(8 6 18 \/ 0\.45\)/);
  });
});
