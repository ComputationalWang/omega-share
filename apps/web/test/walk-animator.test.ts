import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT, type MemberId } from "@omega/shared";
import { standDepth } from "../src/furniture";
import { cellCenter } from "../src/layout";
import { EMOTE_LIFT, createAnimator } from "../src/walk/animator";
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
  const stickers: { id: string; frame: string | null; x: number; y: number }[] = [];
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
    drawEmote: (who, frame, x, y) => stickers.push({ id: who, frame, x, y }),
    render: () => {
      renders++;
    },
  });
  return {
    walks,
    anim,
    draws,
    stickers,
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

// OME-415: `emoted` plays once. A wave swaps the avatar's own frames (wave/<avatar>/idle|sit/<dir>); a sticker is drawn
// above the avatar. Same timer → rAF loop as breathing, but on the one-shot's exact frame times.
describe("emotes", () => {
  /** Runs timers and frames until nothing is pending or `until` passes; returns the times frames ran at. */
  function run(s: ReturnType<typeof setup>, from: number, until: number): number[] {
    const at: number[] = [];
    let t = from;
    if (s.frame(t)) at.push(t);
    while (t < until) {
      const timer = s.timers.at(-1);
      if (timer === undefined) break;
      s.timers.length = 0;
      t += timer.ms;
      timer.fn();
      if (s.frame(t)) at.push(t);
    }
    return at;
  }

  function ready(opts: { reduced?: boolean } = {}) {
    const s = setup(opts);
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 4, 9), { id: id("b"), at: cellCenter(5, 1), z: 1, seatFacing: "nw" }], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }, { id: id("b"), avatar: 3 }]);
    s.frame(0);
    s.timers.length = 0;
    s.draws.length = 0;
    s.stickers.length = 0;
    return s;
  }

  const framesOf = (s: ReturnType<typeof setup>, who: string): (string | null)[] => s.draws.filter((d) => d.id === who).map((d) => d.frame);
  const lastSticker = (s: ReturnType<typeof setup>, who: string) => s.stickers.filter((d) => d.id === who).at(-1);

  test("a standing wave plays wave/<avatar>/idle/<dir> on 160 ms frames, then the pose comes back", () => {
    const s = ready({ reduced: false });
    s.at(1000);
    s.anim.emote(id("a"), "wave");
    expect(s.rafs.length).toBe(1);
    const at = run(s, 1000, 2000);
    // Breathing may add a frame on its 400 ms clock; the wave's own frame times are all there.
    for (const t of [1000, 1160, 1320, 1480, 1640, 1800, 1960]) expect(at).toContain(t);
    const a = framesOf(s, "a").filter((f, i, all) => i === 0 || f !== all[i - 1]);
    expect(a.slice(0, 6)).toEqual(["wave/juno/idle/ne/0", "wave/juno/idle/ne/1", "wave/juno/idle/ne/0", "wave/juno/idle/ne/1", "wave/juno/idle/ne/0", "wave/juno/idle/ne/1"]);
    expect(a[6]).toMatch(/^(juno\/idle\/ne\/0|breathe\/juno\/idle\/ne\/1)$/);
    expect(s.stickers.every((x) => x.frame === null)).toBe(true);
  });

  test("a seated wave uses the sit pose and the seat's facing", () => {
    const s = ready();
    s.at(500);
    s.anim.emote(id("b"), "wave");
    s.frame(500);
    expect(framesOf(s, "b").at(-1)).toBe("wave/kiki/sit/nw/0");
  });

  test("a sticker plays emote/<kind> above the avatar for its timing, then goes away; the avatar keeps its pose", () => {
    const s = ready();
    s.at(1000);
    s.anim.emote(id("a"), "heart");
    s.frame(1000);
    const pose = s.draws.filter((d) => d.id === "a").at(-1)?.pose;
    expect(lastSticker(s, "a")).toEqual({ id: "a", frame: "emote/heart/0", x: pose?.x ?? NaN, y: (pose?.y ?? NaN) - EMOTE_LIFT.idle });
    expect(framesOf(s, "a").at(-1)).not.toMatch(/^wave/);
    expect(s.timers.at(-1)?.ms).toBe(80); // exact, not on the 400 ms breathe clock
    const at = run(s, 1000, 3000);
    for (const t of [1080, 1240, 1440, 1640, 1840, 2240, 2320]) expect(at).toContain(t);
    const shown = s.stickers.filter((x) => x.id === "a" && x.frame !== null).map((x) => x.frame);
    expect(shown.filter((f, i) => i === 0 || f !== shown[i - 1])).toEqual([
      "emote/heart/0", "emote/heart/1", "emote/heart/2", "emote/heart/1", "emote/heart/2", "emote/heart/1", "emote/heart/0",
    ]);
    expect(lastSticker(s, "a")?.frame).toBeNull();
  });

  test("a seated member's sticker sits lower, over the seated head", () => {
    const s = ready();
    s.at(0);
    s.anim.emote(id("b"), "clap");
    s.frame(0);
    expect(lastSticker(s, "b")?.y).toBe(cellCenter(5, 1).y - EMOTE_LIFT.sit);
  });

  test("a new sticker replaces the one still playing, from its first frame", () => {
    const s = ready();
    s.at(0);
    s.anim.emote(id("a"), "heart");
    s.frame(0);
    s.at(500);
    s.anim.emote(id("a"), "laugh");
    s.frame(500);
    expect(lastSticker(s, "a")?.frame).toBe("emote/laugh/0");
  });

  test("a sticker rides along with a walker", () => {
    const s = ready();
    s.walks.place([standAt("a", 4, 8), { id: id("b"), at: cellCenter(5, 1), z: 1, seatFacing: "nw" }], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }, { id: id("b"), avatar: 3 }]);
    s.anim.emote(id("a"), "question");
    run(s, 0, 700);
    const moving = s.stickers.filter((x) => x.id === "a" && x.frame !== null);
    expect(new Set(moving.map((x) => x.y)).size).toBeGreaterThan(1);
    for (const st of moving) {
      const d = s.draws.filter((x) => x.id === "a").find((x) => x.pose.x === st.x);
      expect(d).toBeDefined();
    }
  });

  test("prefers-reduced-motion: no frame swaps, no sticker sprite, no timers (room.ts shows a static badge)", () => {
    const s = ready({ reduced: true });
    s.anim.emote(id("a"), "wave");
    s.anim.emote(id("b"), "heart");
    expect(s.rafs.length).toBe(0);
    expect(s.timers.length).toBe(0);
    expect(s.draws.some((d) => d.frame?.startsWith("wave") === true)).toBe(false);
    expect(s.stickers.some((x) => x.frame !== null)).toBe(false);
  });

  test("an emote from someone not in the room draws nothing", () => {
    const s = ready();
    s.anim.emote(id("zz"), "heart");
    expect(s.rafs.length).toBe(0);
    expect(s.stickers.some((x) => x.id === "zz")).toBe(false);
  });

  test("before the motion atlas is in, emotes draw nothing and leave no timer behind", () => {
    const s = setup();
    s.walks.place([standAt("a", 4, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.anim.emote(id("a"), "heart");
    s.frame(0);
    expect(s.stickers.every((x) => x.frame === null)).toBe(true);
    expect(s.timers.length).toBe(0);
  });

  test("8 people emoting together share their redraws: one render per frame change, not one per person", () => {
    const s = setup();
    s.anim.setFrames(frames);
    const people = Array.from({ length: 8 }, (_, i) => standAt(`p${String(i)}`, i, 9));
    s.walks.place(people, 0);
    s.anim.set(people.map((p, i) => ({ id: p.id, avatar: i % 4 })));
    s.frame(0);
    s.timers.length = 0;
    const before = s.renders();
    s.at(1000);
    for (const p of people) s.anim.emote(p.id, "heart");
    const at = run(s, 1000, 2400);
    // 7 sticker frames + the frame that clears them; breathing changes may add a few on the shared 400 ms clock.
    expect(s.renders() - before).toBe(at.length);
    expect(at.length).toBeLessThanOrEqual(8 + 4);
  });
});
