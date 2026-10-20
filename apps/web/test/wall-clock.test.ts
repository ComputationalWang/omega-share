import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { clockFace, handSteps, minuteTicks, type HandSteps } from "../src/wall-clock";

/** furniture-v2.png is 8-bit indexed with filter 0 on every row (assets/src/png.ts): pixels as 0xRRGGBB, -1 transparent. */
async function decodeSheet(): Promise<{ w: number; px: (x: number, y: number) => number }> {
  const png = new Uint8Array(await Bun.file(new URL("../../../assets/furniture/furniture-v2.png", import.meta.url)).arrayBuffer());
  const view = new DataView(png.buffer);
  let w = 0;
  let plte = new Uint8Array(0);
  let trns = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  for (let o = 8; o < png.length; ) {
    const len = view.getUint32(o);
    const type = new TextDecoder().decode(png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") w = view.getUint32(o + 8);
    if (type === "PLTE") plte = data;
    if (type === "tRNS") trns = data;
    if (type === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return {
    w,
    px: (x, y) => {
      const i = raw[y * (w + 1) + 1 + x] ?? 0;
      if ((trns[i] ?? 255) === 0) return -1;
      return ((plte[i * 3] ?? 0) << 16) | ((plte[i * 3 + 1] ?? 0) << 8) | (plte[i * 3 + 2] ?? 0);
    },
  };
}

const manifest = (await Bun.file(new URL("../../../assets/furniture/furniture-v2.json", import.meta.url)).json()) as {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; anchor: { x: number; y: number } }>;
};
const sheet = await decodeSheet();
const OUTLINE = 0x2b1d2f;

/** The clock's baked frame with `face` drawn over it, as rows of 0xRRGGBB (-1 transparent). */
function composed(facing: "se" | "sw", steps: HandSteps | null): number[][] {
  const f = manifest.frames[`furniture/wallclock/brass/${facing}/back`];
  if (f === undefined) throw new Error("no clock frame");
  const ax = Math.round(f.anchor.x * f.frame.w);
  const ay = Math.round(f.anchor.y * f.frame.h);
  const rows = Array.from({ length: f.frame.h }, (_, y) => Array.from({ length: f.frame.w }, (_, x) => sheet.px(f.frame.x + x, f.frame.y + y)));
  if (steps !== null) {
    for (const p of clockFace(facing, steps)) {
      const row = rows[p.y + ay];
      if (row === undefined || p.x + ax < 0 || p.x + ax >= row.length) throw new Error("face pixel off the frame");
      row[p.x + ax] = p.color;
    }
  }
  return rows;
}

/** The dark hand pixels on the face, relative to the hub (the light-mustard pixel ringed by face and hands). */
function hands(rows: number[][]): { hub: [number, number]; dark: [number, number][] } {
  let hub: [number, number] = [-1, -1];
  const face = new Set<string>();
  rows.forEach((r, y) => {
    r.forEach((c, x) => {
      const faceOrHand = (c?: number): boolean => c === 0xfff7ea || c === OUTLINE;
      if (c === 0xf7d36b && faceOrHand(r[x - 1]) && faceOrHand(r[x + 1]) && faceOrHand(rows[y - 1]?.[x]) && faceOrHand(rows[y + 1]?.[x])) hub = [x, y];
      if (c === 0xfff7ea) face.add(`${String(x)},${String(y)}`);
    });
  });
  const dark: [number, number][] = [];
  rows.forEach((r, y) => {
    r.forEach((c, x) => {
      // A hand pixel: dark, and next to the cream face or the hub (not the clock's own outline).
      const near = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx = 0, dy = 0]) => face.has(`${String(x + dx)},${String(y + dy)}`));
      if (c === OUTLINE && near) dark.push([x - hub[0], y - hub[1]]);
    });
  });
  return { hub, dark };
}

/** The screen direction of "right along the wall" for a facing: the se clock hangs on the left wall, the sw one on the right. */
const RIGHT: Record<"se" | "sw", readonly [number, number]> = { se: [2, -1], sw: [2, 1] };

/** A hand at clock angle θ (clockwise from 12) points this way on screen: right along the wall by sin θ, up by cos θ. */
const screenDir = (facing: "se" | "sw", theta: number): [number, number] => {
  const [rx, ry] = RIGHT[facing];
  return [rx * Math.sin(theta), ry * Math.sin(theta) - Math.cos(theta)];
};

describe("handSteps: the viewer's local time to hand positions", () => {
  test("12-step hour (on the hour mark) and 60-step minute", () => {
    expect(handSteps(new Date(2026, 9, 20, 3, 0, 0))).toEqual({ hour: 3, minute: 0 });
    expect(handSteps(new Date(2026, 9, 20, 18, 30, 59))).toEqual({ hour: 6, minute: 30 });
    expect(handSteps(new Date(2026, 9, 20, 21, 45, 10))).toEqual({ hour: 9, minute: 45 });
    expect(handSteps(new Date(2026, 9, 20, 0, 59, 0))).toEqual({ hour: 0, minute: 59 });
    expect(handSteps(new Date(2026, 9, 20, 12, 1, 0))).toEqual({ hour: 0, minute: 1 });
  });
});

describe("clockFace: the hands drawn over the clock's own face", () => {
  test("at the time the art shows, the overlay is pixel-identical to the baked frame (same face, same palette)", () => {
    // The art's local frame is mirrored on se (its +x runs left on screen), so its ten past ten reads 1:50 there.
    expect(composed("sw", { hour: 10, minute: 10 })).toEqual(composed("sw", null));
    expect(composed("se", { hour: 2, minute: 50 })).toEqual(composed("se", null));
  });

  test("only the clock's own colours: cream face, brass hub, dark hands", () => {
    for (const facing of ["se", "sw"] as const) for (const p of clockFace(facing, { hour: 4, minute: 23 })) expect([0xfff7ea, 0xf7d36b, OUTLINE]).toContain(p.color);
  });

  for (const facing of ["se", "sw"] as const) {
    for (const [h, m] of [[3, 0], [6, 30], [9, 45]] as const) {
      test(`${facing} at ${String(h)}:${String(m).padStart(2, "0")}: every hand pixel lies on the hour or the minute hand, both are drawn`, () => {
        const { dark } = hands(composed(facing, { hour: h, minute: m }));
        const hour = screenDir(facing, (h * Math.PI) / 6);
        const minute = screenDir(facing, (m * Math.PI) / 30);
        // How far along a hand, in the art's units (a unit along the wall is 2 px across, a unit up 1 px).
        const along = (d: [number, number], [x, y]: [number, number]): number => (x * d[0] + y * d[1]) / (d[0] * d[0] + d[1] * d[1]);
        const off = (d: [number, number], [x, y]: [number, number]): number => Math.abs(x * d[1] - y * d[0]) / Math.hypot(d[0], d[1]);
        const onHour = dark.filter((p) => along(hour, p) > 0 && off(hour, p) <= 1.2);
        const onMinute = dark.filter((p) => along(minute, p) > 0 && off(minute, p) <= 1.2);
        // The hub pixel sits a little off the face's true centre, so the pixels touching it count as the hands' roots.
        expect(dark.filter(([x, y]) => Math.max(Math.abs(x), Math.abs(y)) > 1 && !onHour.some((p) => p[0] === x && p[1] === y) && !onMinute.some((p) => p[0] === x && p[1] === y))).toEqual([]);
        // The minute hand reaches at least as far as the hour hand (6:30 and 9:45 overlap them).
        expect(Math.max(...onMinute.map((p) => along(minute, p))) + 1e-9).toBeGreaterThanOrEqual(Math.max(...onHour.map((p) => along(hour, p))));
        expect(Math.max(...onHour.map((p) => along(hour, p)))).toBeGreaterThanOrEqual(1.5);
      });
    }
  }

  test("every minute and hour on both facings draws hands that join the hub (no stray pixels)", () => {
    for (const facing of ["se", "sw"] as const) {
      for (let minute = 0; minute < 60; minute++) {
        const pts = clockFace(facing, { hour: minute % 12, minute }).filter((p) => p.color !== 0xfff7ea);
        const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
        const all = new Set(pts.map((p) => key(p.x, p.y)));
        const hub = pts.find((p) => p.color === 0xf7d36b) ?? pts[0];
        if (hub === undefined) throw new Error("no hands");
        const seen = new Set([key(hub.x, hub.y)]);
        const todo = [hub];
        for (let p = todo.pop(); p !== undefined; p = todo.pop()) {
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const k = key(p.x + dx, p.y + dy);
              const q = pts.find((r) => key(r.x, r.y) === k);
              if (q !== undefined && !seen.has(k)) {
                seen.add(k);
                todo.push(q);
              }
            }
          }
        }
        expect(seen.size).toBe(all.size);
      }
    }
  });
});

describe("minuteTicks: once a minute, on the minute, only while the tab is visible", () => {
  function harness(start: number, visible = true) {
    let now = start;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let next = 1;
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: visible ? "visible" : "hidden",
      addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
    };
    const ticks: number[] = [];
    const stop = minuteTicks({
      now: () => new Date(now),
      setTimer: (fn, ms) => {
        timers.set(next, { at: now + ms, fn });
        return next++;
      },
      clearTimer: (h) => timers.delete(h as number),
      document: doc,
      onTick: (d) => ticks.push(d.getTime()),
    });
    const advance = (to: number): void => {
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = to;
    };
    const setVisible = (v: boolean): void => {
      doc.visibilityState = v ? "visible" : "hidden";
      for (const l of listeners) l();
    };
    return { ticks, advance, setVisible, stop, timers, listeners };
  }
  const T0 = new Date(2026, 9, 20, 10, 15, 42, 500).getTime();
  const minute = (m: number): number => new Date(2026, 9, 20, 10, m, 0, 0).getTime();

  test("ticks at once, then on each minute boundary", () => {
    const h = harness(T0);
    h.advance(minute(18) + 10);
    expect(h.ticks).toEqual([T0, minute(16), minute(17), minute(18)]);
  });

  test("a hidden tab has no timer; showing it again catches up at once and realigns", () => {
    const h = harness(T0);
    h.setVisible(false);
    expect(h.timers.size).toBe(0);
    h.advance(minute(40) + 7_000);
    expect(h.ticks).toEqual([T0]);
    h.setVisible(true);
    expect(h.ticks).toEqual([T0, minute(40) + 7_000]);
    h.advance(minute(41));
    expect(h.ticks.at(-1)).toBe(minute(41));
  });

  test("starting hidden waits for the tab; stop clears the timer and the listener", () => {
    const h = harness(T0, false);
    expect(h.ticks).toEqual([]);
    h.setVisible(true);
    expect(h.ticks).toEqual([T0]);
    h.stop();
    expect(h.timers.size).toBe(0);
    expect(h.listeners.size).toBe(0);
  });
});
