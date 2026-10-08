import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT, type MemberId } from "@omega/shared";
import { standDepth } from "../src/furniture";
import { cellCenter } from "../src/layout";
import { createAnimator } from "../src/walk/animator";
import { parseMotion } from "../src/walk/motion";
import { walkGrid } from "../src/walk/path";
import { createWalks, type Pose, type WalkTarget } from "../src/walk/walks";

// OME-408: the room still renders on demand (OME-185). Frames run only while someone walks; at rest, breathing redraws
// once per breathe frame change, through one timer then one rAF (so a hidden tab renders nothing).

const motion: unknown = await Bun.file(new URL("../../../assets/avatars/motion.json", import.meta.url)).json();
const avatars: unknown = await Bun.file(new URL("../../../assets/avatars/avatars.json", import.meta.url)).json();
const frames = parseMotion(motion, avatars);

const id = (s: string): MemberId => s;
const standAt = (who: string, col: number, row: number): WalkTarget => {
  const at = cellCenter(col, row);
  return { id: id(who), at, z: standDepth(at), seatFacing: null };
};

function setup(opts: { reduced?: boolean } = {}) {
  let now = 0;
  const rafs: (() => void)[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let cleared = 0;
  const draws: { id: string; pose: Pose; frame: string | null }[] = [];
  let renders = 0;
  const walks = createWalks({ reducedMotion: () => opts.reduced ?? false });
  walks.setGrid(walkGrid(DEFAULT_LAYOUT));
  const anim = createAnimator({
    walks,
    now: () => now,
    raf: (fn) => {
      rafs.push(fn);
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {
      cleared++;
    },
    reducedMotion: () => opts.reduced ?? false,
    draw: (who, _avatar, pose, frame) => draws.push({ id: who, pose: { ...pose }, frame }),
    render: () => {
      renders++;
    },
  });
  return {
    walks,
    anim,
    draws,
    rafs,
    timers,
    renders: () => renders,
    cleared: () => cleared,
    at: (t: number) => {
      now = t;
    },
    /** Run the pending frame (if any) at time t. */
    frame: (t: number) => {
      now = t;
      const fn = rafs.shift();
      fn?.();
      return fn !== undefined;
    },
  };
}

describe("animator", () => {
  test("nobody walking and no motion atlas: one draw per avatar, no frames, no timers", () => {
    const s = setup();
    s.walks.place([standAt("a", 4, 9), standAt("b", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }, { id: id("b"), avatar: 1 }]);
    expect(s.draws.map((d) => [d.id, d.frame])).toEqual([["a", null], ["b", null]]);
    expect(s.rafs.length).toBe(0);
    expect(s.timers.length).toBe(0);
  });

  test("a walk redraws once per 150 ms step (ADR 0010 stepPx): a timer to the shared step clock, then one frame", () => {
    const s = setup();
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(0);
    s.walks.place([standAt("a", 5, 8)], 0); // one tile, -row: ne
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    expect(s.rafs.length).toBe(0); // no per-frame loop
    expect(s.timers.at(-1)?.ms).toBe(150);
    const before = s.renders();
    s.draws.length = 0;
    let t = 0;
    for (let i = 0; i < 10; i++) {
      const timer = s.timers.at(-1);
      if (timer === undefined || s.draws.at(-1)?.pose.walking === false) break;
      t += timer.ms;
      s.timers.length = 0;
      timer.fn();
      expect(s.frame(t + 5)).toBe(true);
      if (i === 0) expect(s.draws.at(-1)?.frame).toBe("walk/juno/ne/1");
    }
    // Steps at 150, 300, 450, then at rest at 600: four redraws for the tile.
    expect(s.renders() - before).toBe(4);
    expect(s.draws.at(-1)?.pose.walking).toBe(false);
    expect(s.draws.at(-1)?.frame).toMatch(/^(juno\/idle\/ne\/0|breathe\/juno\/idle\/ne\/1)$/);
  });

  test("at rest, breathing schedules one timer for the next frame change; it redraws through a frame", () => {
    const s = setup();
    s.walks.place([standAt("a", 4, 9), standAt("b", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }, { id: id("b"), avatar: 1 }]);
    s.anim.setFrames(frames);
    expect(s.rafs.length).toBe(1); // the atlas arrived: redraw with sprites
    s.frame(0);
    expect(s.timers.length).toBe(1);
    const first = s.timers[0];
    expect(first?.ms).toBeGreaterThan(0);
    expect(first?.ms).toBeLessThanOrEqual(1400 + 400); // the next breathe change, rounded up to the 400 ms clock
    expect(s.rafs.length).toBe(0);
    s.draws.length = 0;
    first?.fn();
    expect(s.rafs.length).toBe(1);
    s.frame(first?.ms ?? 0);
    expect(s.draws.length).toBe(2);
    expect(s.timers.length).toBe(2);
  });

  test("prefers-reduced-motion: no breathing (the pose frame), no timers", () => {
    const s = setup({ reduced: true });
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 4, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 2 }]);
    s.frame(0);
    expect(s.draws.at(-1)?.frame).toBe("mo/idle/ne/0");
    expect(s.timers.length).toBe(0);
    expect(s.rafs.length).toBe(0);
  });

  test("seated people breathe in their sit pose, facing their seat's way", () => {
    const s = setup({ reduced: true });
    s.anim.setFrames(frames);
    s.walks.place([{ id: id("a"), at: cellCenter(5, 1), z: 1, seatFacing: "nw" }], 0);
    s.anim.set([{ id: id("a"), avatar: 3 }]);
    expect(s.draws.at(-1)?.frame).toBe("kiki/sit/nw/0");
  });
});

describe("animator teardown and idle cost", () => {
  test("dispose: a queued step or breathe timer does nothing afterwards, and nothing new is scheduled", () => {
    const s = setup();
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(0); // at rest: a breathe timer is pending
    const breathe = s.timers.at(-1);
    expect(breathe).toBeDefined();
    s.walks.place([standAt("a", 5, 8)], 10);
    s.anim.set([{ id: id("a"), avatar: 0 }]); // walking: a step timer is queued
    const step = s.timers.at(-1);
    expect(step).not.toBe(breathe);
    s.anim.dispose();
    expect(s.cleared()).toBeGreaterThan(0);
    const draws = s.draws.length;
    breathe?.fn();
    step?.fn();
    s.frame(150);
    s.anim.setFrames(frames);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    expect(s.draws.length).toBe(draws);
    expect(s.renders()).toBe(1);
    expect(s.rafs.length).toBe(0);
  });

  test("breathing redraws land on a shared 400 ms clock: 25 people at rest render at most every 400 ms", () => {
    const s = setup();
    s.anim.setFrames(frames);
    const people = Array.from({ length: 25 }, (_, i) => standAt(`p${String(i)}`, i % 10, 9 - Math.floor(i / 10)));
    s.walks.place(people, 0);
    s.anim.set(people.map((p, i) => ({ id: p.id, avatar: i % 4 })));
    let t = 0;
    s.frame(t);
    while (t < 10_000) {
      const timer = s.timers.at(-1);
      if (timer === undefined) break;
      t += timer.ms;
      expect(t % 400).toBe(0);
      s.timers.length = 0;
      timer.fn();
      s.frame(t);
    }
    expect(t).toBeGreaterThanOrEqual(10_000);
    expect(s.renders()).toBeLessThanOrEqual(10_000 / 400 + 1);
  });
});
