// The phone watch layout (OME-596, M7 W4, set k `ui-m7-watch`): on screens ≤ 600 px wide the TV is full width, the room
// is at 1× (never scaled) and cropped to a window you can drag, and the page reaches the screen's edges (viewport-fit=cover)
// with the safe-area insets kept clear.
import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT } from "@omega/shared";
import { seatPoints } from "../src/furniture";
import { PHONE_MAX_W, PHONE_QUERY, PHONE_ROOM_H, PHONE_ROOM_MIN_H, fullscreenLayout, portraitLayout, STAGE_H, STAGE_W, panTo, roomLayout, seatsHome, type Rect } from "../src/layout";

const SEATS = seatPoints(DEFAULT_LAYOUT);
const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const PHONE_WIDTHS = [320, 356, 360, 375, 390, 412, 430, 480, 540, 600];

describe("phone breakpoint (set k: phone ≤ 600 px wide)", () => {
  test("the query is the design's breakpoint", () => {
    expect(PHONE_MAX_W).toBe(600);
    expect(PHONE_QUERY).toBe("(max-width: 600px)");
  });
});

describe("roomLayout, phone: ADR 0012 player minimum", () => {
  test.each(PHONE_WIDTHS)("the TV keeps YouTube's 200×200, fills the width and never passes it at width %p (OME-1302)", (width) => {
    const { tv } = roomLayout(width, "youtube", true);
    expect(tv).toMatchObject({ x: 0, w: width });
    expect(tv.h).toBeGreaterThanOrEqual(200);
    if (width >= 356) expect(Math.abs(tv.w / tv.h - 16 / 9)).toBeLessThan(0.01);
  });

  test("at 320 px the TV is 320×200: the player letterboxes, the page never scrolls sideways (QA OME-1300 F3)", () => {
    expect(roomLayout(320, null, true).tv).toMatchObject({ x: 0, w: 320, h: 200 });
  });

  test.each(["open", "band"] as const)("full screen at 320×640, strip %p: the picture is on the screen and ≥ 200×200 (QA OME-1300 F2)", (strip) => {
    const l = fullscreenLayout(320, 640, "youtube", strip);
    expect(l.tv.x).toBeGreaterThanOrEqual(0);
    expect(l.tv.x + l.tv.w).toBeLessThanOrEqual(320);
    expect(l.tv.h).toBeGreaterThanOrEqual(200);
    expect(l.strip.x).toBeGreaterThanOrEqual(0);
    expect(l.strip.x + l.strip.w).toBeLessThanOrEqual(320);
  });

  test("portrait: the room window is whole (room for its zoom keys and a strip of room) or gone, never a sliver (QA OME-1300 F4)", () => {
    for (let h = 200; h <= 800; h++) {
      const { stage } = portraitLayout(390, h, null, false);
      expect(stage.h === 0 || stage.h >= PHONE_ROOM_MIN_H).toBe(true);
    }
    expect(PHONE_ROOM_MIN_H).toBeGreaterThanOrEqual(96);
  });

  test("at 360 px the TV fills the container's width (356 px inside a 2 px page margin)", () => {
    expect(roomLayout(356, "youtube", true).tv).toMatchObject({ x: 0, w: 356, h: 200 });
  });

  test("full width on any phone: a 390 px container gives a 390×219 TV (set k)", () => {
    expect(roomLayout(390, "vimeo", true).tv).toMatchObject({ x: 0, w: 390, h: 219 });
  });

  test("Twitch keeps its 534×300 minimum on a phone too (the page scrolls sideways, the player never shrinks)", () => {
    const { tv } = roomLayout(360, "twitch", true);
    expect(tv.w).toBeGreaterThanOrEqual(534);
    expect(tv.h).toBeGreaterThanOrEqual(300);
  });

  test.each(PHONE_WIDTHS)("compact bezel and shelf, the shelf under the TV, the room under the shelf, nothing over the player at %p", (width) => {
    const l = roomLayout(width, null, true);
    expect(l.compact).toEqual({ tv: true, controls: true });
    expect(l.controls.y).toBeGreaterThanOrEqual(l.tv.y + l.tv.h);
    expect(l.controls.h).toBeGreaterThanOrEqual(44);
    expect(intersects(l.stage, l.tv)).toBe(false);
    expect(intersects(l.stage, l.controls)).toBe(false);
    expect(l.height).toBe(l.stage.y + l.stage.h);
  });
});

describe("roomLayout, phone: the room at 1×, cropped", () => {
  test.each(PHONE_WIDTHS)("never scaled, a window as wide as the container and PHONE_ROOM_H tall at %p", (width) => {
    const { stage, scale } = roomLayout(width, null, true);
    expect(scale).toBe(1);
    expect(stage).toMatchObject({ x: 0, w: width, h: PHONE_ROOM_H });
  });

  test("set k's crop is 270 px tall", () => {
    expect(PHONE_ROOM_H).toBe(270);
  });

  test("off the phone nothing changes: the stage still scales to fit", () => {
    expect(roomLayout(800, null, false)).toEqual(roomLayout(800));
    expect(roomLayout(390).scale).toBeLessThan(1);
  });
});

describe("panTo: where the cropped window looks", () => {
  const view = { w: 390, h: PHONE_ROOM_H };

  test("centres the window on a point in the middle of the stage", () => {
    expect(panTo(view, { x: 480, y: 350 })).toEqual({ x: 285, y: 215 });
  });

  test("clamps at the stage's edges, so the window never shows past the room", () => {
    expect(panTo(view, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(panTo(view, { x: STAGE_W, y: STAGE_H })).toEqual({ x: STAGE_W - 390, y: STAGE_H - PHONE_ROOM_H });
  });

  test("whole pixels only (the art stays crisp)", () => {
    const p = panTo(view, { x: 480.4, y: 349.6 });
    expect(Number.isInteger(p.x)).toBe(true);
    expect(Number.isInteger(p.y)).toBe(true);
  });

  test("a window wider than the stage sits at 0", () => {
    expect(panTo({ w: 1200, h: 700 }, { x: 480, y: 300 })).toEqual({ x: 0, y: 0 });
  });

  test.each(SEATS.map((s, i) => [i, s] as const))("centred on seat %p, that seat is inside the window", (_, seat) => {
    const p = panTo(view, seat);
    expect(seat.x).toBeGreaterThanOrEqual(p.x);
    expect(seat.x).toBeLessThanOrEqual(p.x + view.w);
    expect(seat.y).toBeGreaterThanOrEqual(p.y);
    expect(seat.y).toBeLessThanOrEqual(p.y + view.h);
  });
});

describe("edge to edge: viewport-fit=cover and safe areas (index.html, style.css)", () => {
  const html = Bun.file(new URL("../index.html", import.meta.url)).text();
  const css = Bun.file(new URL("../src/style.css", import.meta.url)).text();

  test("the viewport meta asks for viewport-fit=cover", async () => {
    const m = /<meta name="viewport" content="([^"]+)"/.exec(await html);
    expect(m?.[1]?.split(/,\s*/)).toContain("viewport-fit=cover");
  });

  test("the page keeps every inset clear: left, right and top on main, bottom on the footer", async () => {
    const text = await css;
    const rule = (sel: string): string => new RegExp(`(?:^|\\n)${sel.replace(".", "\\.")} \\{([^}]*)\\}`).exec(text)?.[1] ?? "";
    for (const side of ["left", "right", "top"]) expect(rule("main")).toContain(`env(safe-area-inset-${side}`);
    expect(rule(".site-footer")).toContain("env(safe-area-inset-bottom");
  });
});

describe("where the window looks first (QA OME-1324 G3)", () => {
  const ys = SEATS.map((p) => p.y);
  const top = Math.min(...ys);
  const front = Math.max(...ys);
  test("a window tall enough for every seat looks at their middle", () => {
    expect(seatsHome(SEATS, 400).y).toBe((top + front) / 2);
  });
  test("a shorter one shows the front row whole (its 44 px hit areas) instead of every row cropped", () => {
    const h = 77;
    const pan = panTo({ w: 320, h }, seatsHome(SEATS, h));
    for (const y of ys.filter((v) => v === front)) {
      expect(y - 22).toBeGreaterThanOrEqual(pan.y);
      expect(y + 22).toBeLessThanOrEqual(pan.y + h);
    }
  });
  test("no seats: the stage's middle", () => {
    expect(seatsHome([], 100)).toEqual({ x: STAGE_W / 2, y: STAGE_H / 2 });
  });
});
