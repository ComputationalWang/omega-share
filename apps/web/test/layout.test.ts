import { describe, expect, test } from "bun:test";
import { SEATS, STANDING, bubbleRect, roomLayout, stageToPage, tagRect, type Rect } from "../src/layout";

const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect): boolean => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

const WIDTHS: number[] = [];
for (let w = 360; w <= 1920; w += 8) WIDTHS.push(w);
WIDTHS.push(375, 390, 412, 1366, 1440, 1919.5);

describe("roomLayout: YouTube RMF player size", () => {
  test.each(WIDTHS)("the TV is at least 356×200 CSS px after scaling at width %p", (width) => {
    const { tv } = roomLayout(width);
    expect(tv.w).toBeGreaterThanOrEqual(356);
    expect(tv.h).toBeGreaterThanOrEqual(200);
  });

  test("the TV still meets the minimum when the container is narrower than it", () => {
    const { tv } = roomLayout(300);
    expect(tv.w).toBeGreaterThanOrEqual(356);
    expect(tv.h).toBeGreaterThanOrEqual(200);
  });

  test("the TV is 16:9 and grows on wide windows", () => {
    expect(roomLayout(360).tv).toMatchObject({ w: 356, h: 200 });
    const wide = roomLayout(1920).tv;
    expect(wide.w).toBeGreaterThan(356);
    expect(Math.abs(wide.w / wide.h - 16 / 9)).toBeLessThan(0.01);
  });
});

describe("roomLayout: nothing of ours over the player", () => {
  test.each(WIDTHS)("the control bar sits directly below the TV, never over it, at width %p", (width) => {
    const { tv, controls } = roomLayout(width);
    expect(intersects(controls, tv)).toBe(false);
    expect(controls.y).toBeGreaterThanOrEqual(tv.y + tv.h);
    expect(controls.y - (tv.y + tv.h)).toBeLessThanOrEqual(16);
    expect(controls.x).toBe(tv.x);
    expect(controls.w).toBe(tv.w);
    // Set (e) chrome at 1×: 8 px panel border + 4 px padding around a 20 px key, both sides.
    expect(controls.h).toBeGreaterThanOrEqual(44);
  });

  test.each(WIDTHS)("the stage never overlaps the TV or the control bar at width %p", (width) => {
    const { tv, controls, stage } = roomLayout(width);
    expect(intersects(stage, tv)).toBe(false);
    expect(intersects(stage, controls)).toBe(false);
  });

  const spots = [...SEATS.map((p, i) => ({ name: `seat ${String(i)}`, p })), ...STANDING.map((p, i) => ({ name: `standing ${String(i)}`, p }))];

  test.each([360, 412, 768, 1024, 1920])("no bubble or tag intersects the TV or control bar, for every seat and standing spot, at width %p", (width) => {
    const l = roomLayout(width);
    for (const { name, p } of spots) {
      for (const [kind, r] of [["bubble", bubbleRect(p)], ["tag", tagRect(p)]] as const) {
        const onPage = stageToPage(l, r);
        expect({ name, kind, overTv: intersects(onPage, l.tv) }).toEqual({ name, kind, overTv: false });
        expect({ name, kind, overControls: intersects(onPage, l.controls) }).toEqual({ name, kind, overControls: false });
        // Clipped by the stage, so it can't reach the TV even if the box estimate is off.
        expect({ name, kind, inStage: inside(onPage, l.stage) }).toEqual({ name, kind, inStage: true });
      }
    }
  });

  test("a back-row bubble sits above its seat and inside the stage", () => {
    const backRow = SEATS[0];
    expect(backRow).toBeDefined();
    if (backRow === undefined) return;
    const b = bubbleRect(backRow);
    expect(b.y + b.h).toBeLessThan(backRow.y);
    expect(b.y).toBeGreaterThanOrEqual(0);
  });

  test("the stage scales to fit and the block height covers it", () => {
    const l = roomLayout(480);
    expect(l.stage.w).toBeLessThanOrEqual(480);
    expect(l.height).toBe(l.stage.y + l.stage.h);
    expect(roomLayout(1920).scale).toBe(1);
  });
});
