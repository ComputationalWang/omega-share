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

const id = (s: string): MemberId => s as MemberId;
const standAt = (who: string, col: number, row: number): WalkTarget => {
  const at = cellCenter(col, row);
  return { id: id(who), at, z: standDepth(at), seatFacing: null };
};

function setup(opts: { reduced?: boolean } = {}) {
  let now = 0;
  const rafs: (() => void)[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
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
    clearTimer: () => undefined,
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

  test("a walk runs one frame at a time until it arrives, then stops asking for frames", () => {
    const s = setup();
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.walks.place([standAt("a", 5, 8)], 0); // one tile, -row: ne
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    expect(s.rafs.length).toBe(1); // never two loops
    s.draws.length = 0;
    expect(s.frame(160)).toBe(true);
    expect(s.draws.at(-1)?.frame).toBe("walk/juno/ne/1");
    expect(s.renders()).toBe(1);
    let t = 160;
    while (s.frame((t += 16))) if (t > 5000) break;
    expect(t).toBeLessThan(700);
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
    expect(first?.ms).toBeLessThanOrEqual(1400);
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
