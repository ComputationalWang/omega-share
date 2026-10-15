// Holiday themes (OME-1186, ADR 0052): which theme a local date gets, the override key, where decor goes and the
// effect's particles.
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, type RoomLayout } from "@omega/shared";
import { RoomManifestSchema, sceneOf } from "../src/furniture";
import { decorSprites } from "../src/theme/decor";
import { EFFECT_MIN_INTERVAL_MS, MAX_EFFECT_SPRITES, createEffectPainter, createParticles, type EffectMotion, type Particles } from "../src/theme/effect";
import { activeTheme, easterSunday, resolveTheme, type ThemeId } from "../src/theme/periods";

const room = v.parse(RoomManifestSchema, await Bun.file(new URL("../../../assets/room/room.json", import.meta.url)).json());

/** Local midnight and the last minute of a local day: both are that day. */
const at = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m - 1, d, h, min);

describe("activeTheme: local date, both ends inclusive", () => {
  const cases: [string, number, number, ThemeId | null][] = [
    ["Oct 23", 10, 23, null],
    ["Oct 24", 10, 24, "halloween"],
    ["Oct 31", 10, 31, "halloween"],
    ["Nov 1", 11, 1, "halloween"],
    ["Nov 2", 11, 2, null],
    ["Nov 13", 11, 13, null],
    ["Nov 14", 11, 14, "sinterklaas"],
    ["Dec 6", 12, 6, "sinterklaas"],
    ["Dec 7", 12, 7, "christmas"],
    ["Dec 31", 12, 31, "christmas"],
    ["Jan 1", 1, 1, null],
    ["Feb 9", 2, 9, null],
    ["Feb 10", 2, 10, "valentine"],
    ["Feb 14", 2, 14, "valentine"],
    ["Feb 15", 2, 15, null],
    ["Jul 1", 7, 1, null],
  ];
  for (const [name, m, d, want] of cases) {
    test(`${name} → ${String(want)}`, () => {
      expect(activeTheme(at(2026, m, d))).toBe(want);
      expect(activeTheme(at(2026, m, d, 23, 59))).toBe(want);
    });
  }
});

describe("Easter: Gregorian computus, Palm Sunday through Easter Monday", () => {
  // Western Easter Sundays, from the published tables.
  const sundays: [number, number, number][] = [
    [2026, 4, 5],
    [2027, 3, 28],
    [2028, 4, 16],
    [2029, 4, 1],
    [2030, 4, 21],
  ];
  for (const [y, m, d] of sundays) {
    test(`${String(y)}: Easter Sunday is ${String(m)}/${String(d)}`, () => {
      expect(easterSunday(y)).toEqual({ month: m, day: d });
    });
    test(`${String(y)}: the theme runs Easter − 7 days to Easter + 1 day`, () => {
      const sunday = at(y, m, d);
      const shift = (days: number): Date => new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + days, 12);
      expect(activeTheme(shift(-8))).toBeNull();
      expect(activeTheme(shift(-7))).toBe("easter");
      expect(activeTheme(shift(0))).toBe("easter");
      expect(activeTheme(shift(1))).toBe("easter");
      expect(activeTheme(shift(2))).toBeNull();
    });
  }
});

describe("resolveTheme: localStorage omega.theme", () => {
  const july = at(2026, 7, 1);
  const halloween = at(2026, 10, 30);
  test("no override follows the date", () => {
    expect(resolveTheme(halloween, null)).toBe("halloween");
    expect(resolveTheme(july, null)).toBeNull();
  });
  test("a theme id forces that theme on any date", () => {
    expect(resolveTheme(july, "christmas")).toBe("christmas");
    expect(resolveTheme(halloween, "easter")).toBe("easter");
  });
  test("off turns themes off", () => {
    expect(resolveTheme(halloween, "off")).toBeNull();
  });
  test("a bad value is ignored", () => {
    for (const bad of ["", "Christmas", "xmas", " christmas", "__proto__", "toString"]) expect(resolveTheme(halloween, bad)).toBe("halloween");
  });
});

describe("decorSprites: classic room only, on its wall frames", () => {
  const decor = [
    { key: "t/window", on: "wall/l/window0" },
    { key: "t/corner", on: "wall/corner" },
    { key: "t/nowhere", on: "wall/l/missing" },
  ];
  test("the default (classic) layout gets each piece at its wall frame's floor point", () => {
    const scene = sceneOf(DEFAULT_LAYOUT, [], room);
    const window0 = scene.sprites.find((s) => s.key === "wall/l/window0");
    const corner = scene.sprites.find((s) => s.key === "wall/corner");
    expect(window0).toBeDefined();
    expect(decorSprites(scene, decor)).toEqual([
      { key: "t/window", x: window0?.x ?? NaN, y: window0?.y ?? NaN },
      { key: "t/corner", x: corner?.x ?? NaN, y: corner?.y ?? NaN },
    ]);
  });
  test("an equal layout parsed from a snapshot is classic too", () => {
    const copy: RoomLayout = structuredClone(DEFAULT_LAYOUT);
    expect(decorSprites(sceneOf(copy, [], room), decor)).toHaveLength(2);
  });
  test("any other layout gets no decor", () => {
    const edited: RoomLayout = { furniture: DEFAULT_LAYOUT.furniture.slice(1) };
    expect(decorSprites(sceneOf(edited, [], room), decor)).toEqual([]);
  });
  test("no walls yet (room atlas not loaded): no decor", () => {
    expect(decorSprites(sceneOf(DEFAULT_LAYOUT, [], null), decor)).toEqual([]);
  });
});

describe("createParticles: a fixed pool moving in whole pixels", () => {
  const snow: EffectMotion = { area: { x: 0, y: 0, w: 960, h: 600 }, vx: [-10, 10], vy: [25, 50], flipX: false };
  /** Deterministic stand-in for Math.random. */
  const lcg = (seed: number) => (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  test("never more than 40 sprites", () => {
    expect(MAX_EFFECT_SPRITES).toBe(40);
    expect(createParticles(snow, 500, lcg(1)).count).toBe(40);
    expect(createParticles(snow, 6, lcg(1)).count).toBe(6);
  });

  test("whole-pixel positions near the area, over a long run", () => {
    const p = createParticles(snow, 40, lcg(2));
    for (let s = 0; s < 3000; s++) {
      p.step(EFFECT_MIN_INTERVAL_MS);
      for (let i = 0; i < p.count; i++) {
        const x = p.x[i] ?? NaN;
        const y = p.y[i] ?? NaN;
        expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
        expect(x >= -32 && x <= 960 + 32 && y >= -32 && y <= 600 + 32).toBe(true);
      }
    }
  });

  test("snow falls: y grows between wraps", () => {
    const p = createParticles(snow, 1, lcg(3));
    const y0 = p.y[0] ?? NaN;
    p.step(200);
    expect(p.y[0] ?? NaN).toBeGreaterThan(y0);
  });

  test("a step reuses the same arrays (no per-frame allocation)", () => {
    const p = createParticles(snow, 10, lcg(4));
    const { x, y, flip } = p;
    p.step(33);
    expect(p.x).toBe(x);
    expect(p.y).toBe(y);
    expect(p.flip).toBe(flip);
  });

  test("flipX sends some each way and marks the left-goers flipped", () => {
    const bats: EffectMotion = { area: { x: 80, y: 60, w: 800, h: 200 }, vx: [30, 60], vy: [-4, 4], flipX: true };
    const p = createParticles(bats, 40, lcg(5));
    const before = Array.from(p.x);
    p.step(100);
    let left = 0;
    for (let i = 0; i < p.count; i++) {
      const goesLeft = (p.x[i] ?? 0) < (before[i] ?? 0);
      if (goesLeft) left++;
      expect(p.flip[i] === 1).toBe(goesLeft);
    }
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(40);
  });

  test("the loop is capped at 30 Hz", () => {
    expect(1000 / EFFECT_MIN_INTERVAL_MS).toBeLessThanOrEqual(30.31);
  });
});

describe("createEffectPainter: the effect on its own canvas, so a tick never redraws the room (QA OME-1206)", () => {
  type Call = [string, ...number[]];
  /** A 2D context that records calls; the image is opaque to the painter. */
  const fakeCtx = () => {
    const calls: Call[] = [];
    return {
      calls,
      ctx: {
        setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => void calls.push(["setTransform", a, b, c, d, e, f]),
        clearRect: (x: number, y: number, w: number, h: number) => void calls.push(["clearRect", x, y, w, h]),
        drawImage: (_img: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) =>
          void calls.push(["drawImage", sx, sy, sw, sh, dx, dy, dw, dh]),
      },
    };
  };
  const frames = [
    { sx: 0, sy: 0, w: 8, h: 6, ox: 4, oy: 3 },
    { sx: 8, sy: 0, w: 8, h: 6, ox: 4, oy: 3 },
  ];
  /** Two particles at fixed spots: the second goes left (mirrored) with frame phase 1. */
  const still = (): Particles => ({
    count: 2,
    x: Int32Array.of(100, 300),
    y: Int32Array.of(50, 70),
    flip: Uint8Array.of(0, 1),
    phase: Uint8Array.of(0, 1),
    step: () => undefined,
  });
  const image = {} as CanvasImageSource;

  test("paint draws each particle once, at its whole-pixel spot scaled to the canvas, in its own frame", () => {
    const { calls, ctx } = fakeCtx();
    createEffectPainter(ctx, image, frames, 2).paint(still(), 0);
    expect(calls.filter((c) => c[0] === "drawImage")).toEqual([
      ["drawImage", 0, 0, 8, 6, -4, -3, 8, 6],
      ["drawImage", 8, 0, 8, 6, -4, -3, 8, 6],
    ]);
    const transforms = calls.filter((c) => c[0] === "setTransform");
    expect(transforms).toContainEqual(["setTransform", 2, 0, 0, 2, 200, 100]);
    // Mirrored: effect frames face right, a left-goer is flipped about its spot.
    expect(transforms).toContainEqual(["setTransform", -2, 0, 0, 2, 600, 140]);
  });

  test("the step picks the frame: step 1 swaps them", () => {
    const { calls, ctx } = fakeCtx();
    createEffectPainter(ctx, image, frames, 1).paint(still(), 1);
    expect(calls.filter((c) => c[0] === "drawImage").map((c) => c[1])).toEqual([8, 0]);
  });

  test("the next paint clears only where the last one drew, before drawing", () => {
    const { calls, ctx } = fakeCtx();
    const painter = createEffectPainter(ctx, image, frames, 1);
    const p = still();
    painter.paint(p, 0);
    calls.length = 0;
    p.x[0] = 110;
    painter.paint(p, 0);
    const clears = calls.filter((c) => c[0] === "clearRect");
    expect(clears).toHaveLength(2);
    // Each clear covers the old sprite (8×6 around its anchor) wherever the anchor sits in the frame.
    for (const [i, [x, y]] of [[100, 50], [300, 70]].entries()) {
      const c = clears[i] ?? [];
      const [cx, cy, cw, ch] = [c[1] ?? NaN, c[2] ?? NaN, c[3] ?? NaN, c[4] ?? NaN];
      expect(cx <= (x ?? 0) - 8 && cy <= (y ?? 0) - 6 && cx + cw >= (x ?? 0) + 8 && cy + ch >= (y ?? 0) + 6).toBe(true);
    }
    const lastClear = calls.findLastIndex((c) => c[0] === "clearRect");
    const firstDraw = calls.findIndex((c) => c[0] === "drawImage");
    expect(lastClear).toBeLessThan(firstDraw);
  });

  test("clear wipes what was drawn and nothing is drawn", () => {
    const { calls, ctx } = fakeCtx();
    const painter = createEffectPainter(ctx, image, frames, 1);
    painter.paint(still(), 0);
    calls.length = 0;
    painter.clear();
    expect(calls.filter((c) => c[0] === "clearRect")).toHaveLength(2);
    expect(calls.filter((c) => c[0] === "drawImage")).toHaveLength(0);
  });
});
