import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-1631: a received reaction bursts a few glyphs over the sender's head. DOM over the room, never the canvas: a
// pool of at most 12 nodes, made on demand and reused, stepped on one timer for the layer (ADR 0040: no CSS
// animation). The caller's gate turns it off (Basic tier, reduced motion, a Smooth frame near budget).

async function setup(o: { allowed?: () => boolean } = {}) {
  const m = await import("../src/reactions/glyphs");
  const layer = document.createElement("div");
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  const g = m.createReactionGlyphs(layer, {
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
  /** Runs every timer due by `t`, in order. */
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
  const shown = (): HTMLElement[] => [...layer.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.hidden);
  return { ...m, g, layer, timers, advance, shown };
}

describe("reaction glyphs", () => {
  test("a burst shows its glyphs over the head, wearing the kind's icon, decorative", async () => {
    const { g, layer, shown, GLYPHS_PER_BURST, reactionIcon } = await setup();
    expect(g.burst({ x: 100, y: 50 }, "heart")).toBe(GLYPHS_PER_BURST);
    expect(g.live()).toBe(GLYPHS_PER_BURST);
    expect(shown().length).toBe(GLYPHS_PER_BURST);
    for (const n of shown()) {
      expect(n.className).toContain(reactionIcon("heart"));
      expect(n.style.transform).toContain("translate(");
    }
    expect(layer.getAttribute("aria-hidden")).toBe("true");
  });

  test("each kind has its own icon", async () => {
    const { reactionIcon } = await setup();
    const icons = new Set(["heart", "laugh", "wow", "clap"].map((k) => reactionIcon(k as "heart")));
    expect(icons.size).toBe(4);
    for (const i of icons) expect(i).not.toBe("");
  });

  test("at most 12 live: a burst into a full pool shows only what fits, then nothing", async () => {
    const { g, layer, GLYPH_POOL, GLYPHS_PER_BURST } = await setup();
    let total = 0;
    for (let i = 0; i < 10; i++) total += g.burst({ x: i, y: 0 }, "clap");
    expect(total).toBe(GLYPH_POOL);
    expect(g.live()).toBe(GLYPH_POOL);
    expect(layer.children.length).toBe(GLYPH_POOL);
    expect(g.burst({ x: 0, y: 0 }, "clap")).toBe(0);
    expect(GLYPH_POOL % GLYPHS_PER_BURST).toBe(0);
  });

  test("glyphs rise and fade on the shared steps, then hide; their nodes are reused, never more than the pool", async () => {
    const { g, layer, advance, shown, timers, GLYPH_LIFE_MS, GLYPH_POOL } = await setup();
    g.burst({ x: 100, y: 50 }, "wow");
    const first = shown()[0];
    if (first === undefined) throw new Error("no glyph");
    const before = first.style.transform;
    advance(GLYPH_LIFE_MS / 2);
    expect(first.style.transform).not.toBe(before);
    expect(Number(first.style.opacity)).toBeLessThan(1);
    advance(GLYPH_LIFE_MS);
    expect(g.live()).toBe(0);
    expect(shown().length).toBe(0);
    // Idle: the layer's timer stops.
    expect(timers.size).toBe(0);
    for (let i = 0; i < 20; i++) g.burst({ x: 0, y: 0 }, "heart");
    advance(2 * GLYPH_LIFE_MS);
    for (let i = 0; i < 20; i++) g.burst({ x: 0, y: 0 }, "laugh");
    expect(layer.children.length).toBe(GLYPH_POOL);
  });

  test("one timer for the whole layer, however many bursts", async () => {
    const { g, timers } = await setup();
    g.burst({ x: 0, y: 0 }, "heart");
    g.burst({ x: 9, y: 0 }, "clap");
    g.burst({ x: 18, y: 0 }, "wow");
    expect(timers.size).toBe(1);
  });

  test("gated off (Basic, reduced motion, frame near budget): nothing is made or shown", async () => {
    let on = false;
    const { g, layer } = await setup({ allowed: () => on });
    expect(g.burst({ x: 0, y: 0 }, "heart")).toBe(0);
    expect(layer.children.length).toBe(0);
    on = true;
    expect(g.burst({ x: 0, y: 0 }, "heart")).toBeGreaterThan(0);
  });

  test("destroy hides everything and stops the timer", async () => {
    const { g, shown, timers } = await setup();
    g.burst({ x: 0, y: 0 }, "heart");
    g.destroy();
    expect(shown().length).toBe(0);
    expect(timers.size).toBe(0);
    expect(g.burst({ x: 0, y: 0 }, "heart")).toBe(0);
  });
});
