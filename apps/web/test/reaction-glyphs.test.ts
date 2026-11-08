import { describe, expect, test } from "bun:test";
import { GLYPH_LIFE_MS, GLYPH_POOL, GLYPHS_PER_BURST, createReactionGlyphs, glyphFrame, reactionIcon } from "../src/reactions/glyphs";

// OME-1631 / OME-2307: a received reaction bursts a few glyphs over the sender's head, painted on the room canvas.
// The glyphs drive a paint sink (the room view's pooled sprites) and ask for one render per step that changed
// something. A pool of at most 12, stepped on one timer for the layer (ADR 0040). The caller's gate turns it off.

function setup(o: { allowed?: () => boolean } = {}) {
  const shows: { i: number; frame: string; x: number; y: number; alpha: number }[] = [];
  const hides: number[] = [];
  const paint = {
    renders: 0,
    show: (i: number, frame: string, x: number, y: number, alpha: number) => void shows.push({ i, frame, x, y, alpha }),
    hide: (i: number) => void hides.push(i),
    render: () => {
      paint.renders++;
    },
  };
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  const g = createReactionGlyphs(paint, {
    allowed: o.allowed ?? (() => true),
    now: () => now,
    setTimer: (fn, ms) => {
      const h = next++;
      timers.set(h, { fn, at: now + ms });
      return h;
    },
    clearTimer: (h) => {
      if (typeof h === "number") timers.delete(h);
    },
  });
  const advance = (t: number): void => {
    for (;;) {
      let due: [number, { fn: () => void; at: number }] | undefined;
      for (const e of timers) if (e[1].at <= t && (due === undefined || e[1].at < due[1].at)) due = e;
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = t;
  };
  return { g, paint, shows, hides, timers, advance };
}

describe("reaction glyphs", () => {
  test("a burst paints its glyphs over the head on the kind's frame, at whole pixels, with one render", () => {
    const { g, shows, paint } = setup();
    expect(g.burst({ x: 100, y: 50 }, "heart")).toBe(GLYPHS_PER_BURST);
    expect(g.live()).toBe(GLYPHS_PER_BURST);
    expect(shows.length).toBe(GLYPHS_PER_BURST);
    expect(new Set(shows.map((s) => s.i)).size).toBe(GLYPHS_PER_BURST);
    for (const s of shows) {
      expect(s.frame).toBe("emote/heart");
      expect(Number.isInteger(s.x) && Number.isInteger(s.y)).toBe(true);
      expect(s.alpha).toBe(1);
    }
    expect(paint.renders).toBe(1);
    expect(g.active().map((a) => a.kind)).toEqual(Array.from({ length: GLYPHS_PER_BURST }, () => "heart"));
  });

  test("each kind has its own frame and its own bar icon", () => {
    const kinds = ["heart", "laugh", "wow", "clap"] as const;
    expect(new Set(kinds.map(glyphFrame)).size).toBe(4);
    expect(new Set(kinds.map(reactionIcon)).size).toBe(4);
  });

  test("at most 12 live: a burst into a full pool shows only what fits, then nothing", () => {
    const { g, shows, paint } = setup();
    let total = 0;
    for (let i = 0; i < 10; i++) total += g.burst({ x: i, y: 0 }, "clap");
    expect(total).toBe(GLYPH_POOL);
    expect(new Set(shows.map((s) => s.i)).size).toBe(GLYPH_POOL);
    const renders = paint.renders;
    expect(g.burst({ x: 0, y: 0 }, "clap")).toBe(0);
    expect(paint.renders).toBe(renders);
    expect(GLYPH_POOL % GLYPHS_PER_BURST).toBe(0);
  });

  test("glyphs rise and fade on the shared steps, one render per step, then hide; the pool is reused; idle asks for nothing", () => {
    const { g, shows, hides, paint, advance, timers } = setup();
    g.burst({ x: 100, y: 50 }, "wow");
    const start = shows.length;
    const first = shows[0];
    const r0 = paint.renders;
    advance(GLYPH_LIFE_MS / 2);
    expect(paint.renders).toBeGreaterThan(r0);
    const mid = shows.slice(start).filter((s) => s.i === first?.i);
    expect(mid.at(-1)?.y ?? 0).toBeLessThan(first?.y ?? 0);
    expect(mid.at(-1)?.alpha ?? 1).toBeLessThan(1);
    advance(GLYPH_LIFE_MS);
    expect(g.live()).toBe(0);
    expect(hides.length).toBe(GLYPHS_PER_BURST);
    expect(timers.size).toBe(0);
    const idle = paint.renders;
    advance(5 * GLYPH_LIFE_MS);
    expect(paint.renders).toBe(idle);
    for (let i = 0; i < 20; i++) g.burst({ x: 0, y: 0 }, "heart");
    advance(2 * GLYPH_LIFE_MS);
    for (let i = 0; i < 20; i++) g.burst({ x: 0, y: 0 }, "laugh");
    expect(Math.max(...shows.map((s) => s.i))).toBe(GLYPH_POOL - 1);
  });

  test("exactly one render per timer step while live", () => {
    const { g, paint, advance, timers } = setup();
    g.burst({ x: 0, y: 0 }, "heart");
    const before = paint.renders;
    const [t] = [...timers.values()];
    advance(t?.at ?? 0);
    expect(paint.renders).toBe(before + 1);
  });

  test("one timer for the whole layer, however many bursts", () => {
    const { g, timers } = setup();
    g.burst({ x: 0, y: 0 }, "heart");
    g.burst({ x: 9, y: 0 }, "clap");
    g.burst({ x: 18, y: 0 }, "wow");
    expect(timers.size).toBe(1);
  });

  test("gated off (Basic, reduced motion, frame near budget): nothing is painted or rendered", () => {
    let on = false;
    const { g, shows, paint } = setup({ allowed: () => on });
    expect(g.burst({ x: 0, y: 0 }, "heart")).toBe(0);
    expect(shows.length).toBe(0);
    expect(paint.renders).toBe(0);
    on = true;
    expect(g.burst({ x: 0, y: 0 }, "heart")).toBeGreaterThan(0);
  });

  test("destroy hides everything, renders once and stops the timer", () => {
    const { g, hides, paint, timers } = setup();
    g.burst({ x: 0, y: 0 }, "heart");
    const r = paint.renders;
    g.destroy();
    expect(hides.length).toBe(GLYPHS_PER_BURST);
    expect(paint.renders).toBe(r + 1);
    expect(timers.size).toBe(0);
    expect(g.burst({ x: 0, y: 0 }, "heart")).toBe(0);
  });
});
