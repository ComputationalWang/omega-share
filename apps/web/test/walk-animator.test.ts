import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT, type MemberId } from "@omega/shared";
import { standDepth } from "../src/furniture";
import { cellCenter } from "../src/layout";
import { EMOTE_LIFT, createAnimator } from "../src/walk/animator";
import { DIRS, parseMotion } from "../src/walk/motion";
import { THRUST_BACK } from "../src/walk/pair";
import { walkGrid } from "../src/walk/path";
import { createWalks, type Pose, type WalkTarget, type Walks } from "../src/walk/walks";

// OME-408: the room still renders on demand (OME-185). Frames run only while someone walks; at rest, breathing redraws
// once per breathe frame change, through one timer then one rAF (so a hidden tab renders nothing).

const motion: unknown = await Bun.file(new URL("../../../assets/avatars/motion.json", import.meta.url)).json();
const avatars: unknown = await Bun.file(new URL("../../../assets/avatars/avatars.json", import.meta.url)).json();
const expressions: unknown = await Bun.file(new URL("../../../assets/avatars/expressions.json", import.meta.url)).json();
const frames = parseMotion(motion, avatars, expressions);

const id = (s: string): MemberId => s;
const standAt = (who: string, col: number, row: number): WalkTarget => {
  const at = cellCenter(col, row);
  return { id: id(who), at, z: standDepth(at), seatFacing: null };
};

function setup(opts: { reduced?: boolean; smooth?: () => boolean; props?: (now: number) => boolean } = {}) {
  let now = 0;
  const rafs: (() => void)[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let cleared = 0;
  const draws: { id: string; pose: Pose; frame: string | null }[] = [];
  const stickers: { id: string; frame: string | null; x: number; y: number }[] = [];
  const loopDraws: [number, number][] = [];
  let renders = 0;
  const smooth = opts.smooth ?? (() => false);
  const inner = createWalks({ reducedMotion: () => opts.reduced ?? false, smooth });
  let walkingCalls = 0;
  const walks: Walks = {
    ...inner,
    walking: (t) => {
      walkingCalls++;
      return inner.walking(t);
    },
  };
  const rendered: { start: number; walking: boolean }[] = [];
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
    smooth,
    rendered: (start, walking) => rendered.push({ start, walking }),
    draw: (who, _avatar, pose, frame) => draws.push({ id: who, pose: { ...pose }, frame }),
    drawEmote: (who, frame, x, y) => stickers.push({ id: who, frame, x, y }),
    drawLoop: (i, frame) => loopDraws.push([i, frame]),
    ...(opts.props === undefined ? {} : { drawProps: opts.props }),
    render: () => {
      renders++;
    },
  });
  return {
    walks,
    anim,
    draws,
    stickers,
    loopDraws,
    rafs,
    timers,
    renders: () => renders,
    rendered,
    cleared: () => cleared,
    walkingCalls: () => walkingCalls,
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

  function ready(opts: { reduced?: boolean; smooth?: boolean } = {}) {
    const s = setup({ reduced: opts.reduced ?? false, smooth: () => opts.smooth ?? false });
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

  // OME-1378: dance reuses the walk cycle in place, turning se → sw → nw → ne every 4 Basic steps, for 8 s.
  test("a standing dance plays its own walk frames on the 150 ms step clock, turning every 4 steps, for 8 s", () => {
    const s = ready();
    s.at(1000);
    s.anim.emote(id("a"), "dance");
    expect(s.rafs.length).toBe(1);
    const at = run(s, 1000, 9600);
    for (let t = 1050; t <= 9000; t += 150) expect(at).toContain(t);
    const a = framesOf(s, "a").filter((f, i, all) => i === 0 || f !== all[i - 1]);
    const cycle = (d: string) => [0, 1, 2, 3].map((n) => `walk/juno/${d}/${String(n)}`);
    expect(a.slice(0, 20)).toEqual([...cycle("ne"), ...cycle("se"), ...cycle("sw"), ...cycle("nw"), ...cycle("ne")]);
    // Over at 8 s: back to the rest pose, its own facing.
    const after = s.draws.filter((d) => d.id === "a").at(-1);
    expect(after?.frame).toMatch(/^(juno\/idle\/ne\/0|breathe\/juno\/idle\/ne\/1)$/);
    expect(after?.pose.walking).toBe(false);
    expect(s.stickers.every((x) => x.frame === null)).toBe(true);
  });

  test("Smooth dances on walk8, one frame per rAF, and the tier probe counts it as a walk", () => {
    const s = ready({ smooth: true });
    s.at(1000);
    s.anim.emote(id("a"), "dance");
    const shown = new Set<string | null>();
    let t = 1000;
    while (s.rafs.length > 0 && t < 2000) {
      s.frame(t);
      shown.add(framesOf(s, "a").at(-1) ?? null);
      expect(s.timers.length).toBe(0);
      t += 1000 / 60;
    }
    for (const k of ["walk/juno/ne/0", "walk8/juno/ne/1", "walk8/juno/ne/7", "walk/juno/se/0", "walk8/juno/se/3"]) expect(shown.has(k)).toBe(true);
    expect(s.rendered.at(-1)?.walking).toBe(true);
  });

  test("a seated member doesn't dance", () => {
    const s = ready();
    s.at(500);
    s.anim.emote(id("b"), "dance");
    run(s, 500, 2000);
    expect(framesOf(s, "b").some((f) => f?.startsWith("walk") === true)).toBe(false);
  });

  test("walking off ends the dance: arrived, the avatar rests", () => {
    const s = ready();
    s.at(1000);
    s.anim.emote(id("a"), "dance");
    run(s, 1000, 1300);
    s.walks.place([standAt("a", 4, 8), { id: id("b"), at: cellCenter(5, 1), z: 1, seatFacing: "nw" }], 1300);
    s.anim.set([{ id: id("a"), avatar: 0 }, { id: id("b"), avatar: 3 }]);
    run(s, 1300, 5000);
    const last = s.draws.filter((d) => d.id === "a").at(-1);
    expect(last?.pose.walking).toBe(false);
    expect(last?.frame?.startsWith("walk")).toBe(false);
  });

  test("a dancer who leaves stops the step clock", () => {
    const s = ready();
    s.at(1000);
    s.anim.emote(id("a"), "dance");
    s.frame(1000);
    s.anim.set([{ id: id("b"), avatar: 3 }]);
    s.draws.length = 0;
    const at = run(s, 1000, 4000);
    expect(s.draws.some((d) => d.id === "a")).toBe(false);
    // Only b's breathing, on its 400 ms clock.
    expect(at.length).toBeLessThanOrEqual(8);
  });

  // OME-1690: a conga member walks in the dance: its own steps, the facing turning once per cycle; off the line, a plain walk.
  /** a walks a few tiles: per walking draw, the facing its frame shows and the one it travels in. */
  const congaWalk = (s: ReturnType<typeof setup>, from: number, to: [number, number] = [4, 4]): [string, string][] => {
    s.walks.place([standAt("a", ...to), { id: id("b"), at: cellCenter(5, 1), z: 1, seatFacing: "nw" }], from);
    s.anim.set([{ id: id("a"), avatar: 0 }, { id: id("b"), avatar: 3 }]);
    run(s, from, from + 10000);
    return s.draws.filter((d) => d.id === "a" && d.pose.walking).map((d) => [/^walk8?\/juno\/(\w+)\//.exec(d.frame ?? "")?.[1] ?? "", d.pose.dir]);
  };

  test("a conga member walking plays the dance cycle: walk steps, the facing turning off the way it travels", () => {
    const s = ready();
    s.anim.conga([id("a")]);
    const walked = congaWalk(s, 1000);
    expect(walked.every(([shown]) => shown !== "")).toBe(true);
    expect(new Set(walked.map(([shown]) => shown)).size).toBe(4);
    expect(walked.filter(([shown, dir]) => shown !== dir).length).toBeGreaterThan(walked.length / 2);
    expect(s.draws.filter((d) => d.id === "a").at(-1)?.pose.walking).toBe(false);
  });

  test("on a route that turns corners the conga facing still turns one quarter per cycle, never back", () => {
    const s = ready();
    s.anim.conga([id("a")]);
    const walked = congaWalk(s, 1000, [0, 0]);
    const runs = (xs: string[]) => xs.filter((x, i) => x !== xs[i - 1]);
    // The route turns corners (w, n, w, n): each turn changes the travel direction.
    expect(runs(walked.map(([, dir]) => dir)).length).toBeGreaterThanOrEqual(4);
    const shown = runs(walked.map(([f]) => f));
    expect(shown.length).toBeGreaterThanOrEqual(3);
    const order = ["se", "sw", "nw", "ne"];
    for (let i = 1; i < shown.length; i++) expect(order[(order.indexOf(shown[i - 1] ?? "") + 1) % 4]).toBe(shown[i] ?? "");
  });

  test("leaving the conga line goes back to the plain walk", () => {
    const s = ready();
    s.anim.conga([id("a")]);
    s.anim.conga([]);
    const walked = congaWalk(s, 1000);
    expect(walked.length).toBeGreaterThan(0);
    expect(walked.every(([shown, dir]) => shown === dir)).toBe(true);
  });

  test("under reduced motion a conga member walks plainly", () => {
    const s = ready({ reduced: true });
    s.anim.conga([id("a")]);
    expect(congaWalk(s, 1000).every(([shown, dir]) => shown === dir)).toBe(true);
  });

  test("25 dancing together share one render per 150 ms step, like 25 walkers", () => {
    const s = setup();
    s.anim.setFrames(frames);
    const people = Array.from({ length: 25 }, (_, i) => standAt(`p${String(i)}`, i % 10, 9 - Math.floor(i / 10)));
    s.walks.place(people, 0);
    s.anim.set(people.map((p, i) => ({ id: p.id, avatar: i % 4 })));
    s.frame(0);
    s.timers.length = 0;
    const before = s.renders();
    s.at(1000);
    for (const p of people) s.anim.emote(p.id, "dance");
    const at = run(s, 1000, 9000);
    expect(s.renders() - before).toBe(at.length);
    // 8 s of 150 ms steps (54) and the end frame; breathing changes may add some on the shared 400 ms clock.
    expect(at.length).toBeLessThanOrEqual(55 + 20);
  });

  test("prefers-reduced-motion: no frame swaps, no sticker sprite, no timers (room.ts shows a static badge)", () => {
    const s = ready({ reduced: true });
    s.anim.emote(id("a"), "wave");
    s.anim.emote(id("b"), "heart");
    s.anim.emote(id("a"), "cheer");
    s.anim.emote(id("b"), "yawn");
    s.anim.emote(id("a"), "dance");
    expect(s.rafs.length).toBe(0);
    expect(s.timers.length).toBe(0);
    expect(s.draws.some((d) => d.frame?.startsWith("wave") === true)).toBe(false);
    expect(s.stickers.some((x) => x.frame !== null)).toBe(false);
  });

  // OME-1121: cheer and yawn swap the avatar's frames like the wave, from the expressions sheet.
  test("a standing cheer plays cheer/<avatar>/idle/<dir> on 180 ms frames, then the pose comes back", () => {
    const s = ready();
    s.at(1000);
    s.anim.emote(id("a"), "cheer");
    const at = run(s, 1000, 2400);
    for (const t of [1000, 1180, 1360, 1540, 1720, 1900, 2080]) expect(at).toContain(t);
    const a = framesOf(s, "a").filter((f, i, all) => i === 0 || f !== all[i - 1]);
    expect(a.slice(0, 6)).toEqual(["cheer/juno/idle/ne/0", "cheer/juno/idle/ne/1", "cheer/juno/idle/ne/0", "cheer/juno/idle/ne/1", "cheer/juno/idle/ne/0", "cheer/juno/idle/ne/1"]);
    expect(a[6]).toMatch(/^(juno\/idle\/ne\/0|breathe\/juno\/idle\/ne\/1)$/);
    expect(s.stickers.every((x) => x.frame === null)).toBe(true);
  });

  test("a seated yawn holds 900 then 1800 ms in the sit pose and the seat's facing, then the pose comes back", () => {
    const s = ready();
    s.at(500);
    s.anim.emote(id("b"), "yawn");
    const at = run(s, 500, 3500);
    for (const t of [500, 1400, 3200]) expect(at).toContain(t);
    const b = framesOf(s, "b").filter((f, i, all) => i === 0 || f !== all[i - 1]);
    expect(b.slice(0, 2)).toEqual(["yawn/kiki/sit/nw/0", "yawn/kiki/sit/nw/1"]);
    expect(b[2]).toMatch(/^(kiki\/sit\/nw\/0|breathe\/kiki\/sit\/nw\/1)$/);
  });

  // OME-1734: the pet's reach (OME-1697) is standing only, 5 × 160 ms; a seated avatar keeps its pose.
  test("a standing reach plays reach/<avatar>/idle/<dir> on 160 ms frames, then the pose comes back", () => {
    const s = ready();
    s.at(1000);
    s.anim.emote(id("a"), "reach");
    const at = run(s, 1000, 2000);
    for (const t of [1000, 1160, 1320, 1480, 1640, 1800]) expect(at).toContain(t);
    const a = framesOf(s, "a").filter((f, i, all) => i === 0 || f !== all[i - 1]);
    expect(a.slice(0, 5)).toEqual(["reach/juno/idle/ne/0", "reach/juno/idle/ne/1", "reach/juno/idle/ne/0", "reach/juno/idle/ne/1", "reach/juno/idle/ne/0"]);
    expect(a[5]).toMatch(/^(juno\/idle\/ne\/0|breathe\/juno\/idle\/ne\/1)$/);
    expect(s.stickers.every((x) => x.frame === null)).toBe(true);
  });

  test("a seated reach does nothing: the sit pose stays", () => {
    const s = ready();
    s.at(500);
    s.anim.emote(id("b"), "reach");
    s.frame(500);
    expect(framesOf(s, "b").some((f) => f?.startsWith("reach") === true)).toBe(false);
  });

  test("cheer and yawn play seated in every facing, and standing in both resting facings", () => {
    const s = setup();
    s.anim.setFrames(frames);
    const seats = DIRS.map((dir, i) => ({ id: id(`s${dir}`), at: cellCenter(2 + i, 1), z: 1, seatFacing: dir }));
    s.walks.place([standAt("ne", 2, 9), standAt("nw", 9, 2), ...seats], 0);
    const everyone = [id("ne"), id("nw"), ...seats.map((x) => x.id)];
    s.anim.set(everyone.map((who) => ({ id: who, avatar: 1 })));
    for (const kind of ["cheer", "yawn"] as const) {
      s.draws.length = 0;
      s.at(10_000);
      for (const who of everyone) s.anim.emote(who, kind);
      s.frame(10_000);
      const shown = everyone.map((who) => s.draws.filter((d) => d.id === who).at(-1)?.frame);
      expect(shown).toEqual([`${kind}/pip/idle/ne/0`, `${kind}/pip/idle/nw/0`, ...DIRS.map((d) => `${kind}/pip/sit/${d}/0`)]);
      s.at(20_000);
      s.anim.set(everyone.map((who) => ({ id: who, avatar: 1 })));
    }
  });

  test("a cheer started mid-yawn replaces it: one avatar plays one gesture at a time", () => {
    const s = ready();
    s.at(0);
    s.anim.emote(id("a"), "yawn");
    s.frame(0);
    s.at(100);
    s.anim.emote(id("a"), "cheer");
    s.frame(100);
    expect(framesOf(s, "a").at(-1)).toBe("cheer/juno/idle/ne/0");
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

  // OME-1672: the dank-dungeon pair. The thruster's frame is anchored on the bender's floor point and drawn there, just behind.
  describe("pair", () => {
    // The bender at (5, 9) faces the TV's ne, so their front is se; at (9, 5) it is nw, so sw.
    function standing(bender: [number, number] = [5, 9]) {
      const s = setup();
      s.anim.setFrames(frames);
      s.walks.place([standAt("a", bender[0] - 1, bender[1]), standAt("b", ...bender)], 0);
      s.anim.set([{ id: id("a"), avatar: 0 }, { id: id("b"), avatar: 3 }]);
      s.frame(0);
      s.timers.length = 0;
      s.draws.length = 0;
      return s;
    }

    test("the bender plays bendover/<avatar>/<front dir>/0, the thruster thrust/<avatar>/<dir>/<n> just behind the bender", () => {
      const s = standing();
      s.at(1000);
      s.anim.pair(id("a"), id("b"));
      run(s, 1000, 2000);
      const bender = s.draws.filter((d) => d.id === "b").at(-1);
      const thruster = s.draws.filter((d) => d.id === "a").at(-1);
      expect(bender?.frame).toMatch(/^bendover\/kiki\/(se|sw)\/0$/);
      expect(thruster?.frame).toMatch(/^thrust\/juno\/(se|sw)\/[012]$/);
      expect(thruster?.pose.z).toBe((bender?.pose.z ?? 0) - 0.5);
    });

    // OME-1970: the thruster stands THRUST_BACK further back, away from the way the bender faces.
    for (const [dir, at, dx] of [["se", [5, 9], -THRUST_BACK.x], ["sw", [9, 5], THRUST_BACK.x]] as const) {
      test(`facing ${dir}, the thruster is drawn ${String(dx)}, -${String(THRUST_BACK.y)} px from the bender's spot`, () => {
        const s = standing([at[0], at[1]]);
        s.at(1000);
        s.anim.pair(id("a"), id("b"));
        run(s, 1000, 2000);
        const bender = s.draws.filter((d) => d.id === "b").at(-1);
        const thruster = s.draws.filter((d) => d.id === "a").at(-1);
        expect(bender?.frame).toBe(`bendover/kiki/${dir}/0`);
        expect(thruster?.pose.x).toBe((bender?.pose.x ?? 0) + dx);
        expect(thruster?.pose.y).toBe((bender?.pose.y ?? 0) - THRUST_BACK.y);
      });
    }

    test("the thrust loops 0 1 2 1 on 110 ms frames", () => {
      const s = standing();
      s.at(1000);
      s.anim.pair(id("a"), id("b"));
      const at = run(s, 1000, 1500);
      for (const t of [1000, 1110, 1220, 1330, 1440]) expect(at).toContain(t);
      const seq = framesOf(s, "a").filter((f, i, all) => i === 0 || f !== all[i - 1]).slice(0, 4).map((f) => f?.slice(-1));
      expect(seq).toEqual(["0", "1", "2", "1"]);
    });

    test("after a few seconds both are idle again", () => {
      const s = standing();
      s.at(1000);
      s.anim.pair(id("a"), id("b"));
      run(s, 1000, 9000);
      for (const who of ["a", "b"]) expect(framesOf(s, who).at(-1)).not.toMatch(/^(thrust|bendover)\//);
    });

    test("prefers-reduced-motion: nothing is played", () => {
      const s = ready({ reduced: true });
      s.anim.pair(id("a"), id("b"));
      s.frame(0);
      expect(s.draws.some((d) => /^(thrust|bendover)\//.test(d.frame ?? ""))).toBe(false);
    });
  });

  // OME-1691: lying on a piece (assets/avatars/lying.json): the avatar's own lie/curl frames in the piece's facing, a 2-frame breath.
  describe("lying", () => {
    function lying(style: "lie" | "curl", dir: "se" | "ne") {
      const s = setup();
      s.anim.setFrames(frames);
      s.walks.place([{ id: id("a"), at: cellCenter(2, 5), z: 7, seatFacing: dir }, standAt("b", 5, 9)], 0);
      s.anim.set([{ id: id("a"), avatar: 1, lie: style }, { id: id("b"), avatar: 0 }]);
      s.frame(0);
      return s;
    }
    const lieFrames = (s: ReturnType<typeof setup>): (string | null)[] => s.draws.filter((d) => d.id === "a").map((d) => d.frame);

    test("a lier draws the lie frames in the piece's facing, breathing between frame 0 and 1 on the shared clock", () => {
      const s = lying("lie", "ne");
      run(s, 0, 6000);
      const seen = new Set(lieFrames(s));
      expect([...seen].sort()).toEqual(["lie/pip/ne/0", "lie/pip/ne/1"]);
      expect(s.draws.filter((d) => d.id === "a").every((d) => d.pose.z === 7)).toBe(true);
    });

    test("curling up in the cat bed draws the curl frames", () => {
      const s = lying("curl", "se");
      run(s, 0, 6000);
      expect(new Set(lieFrames(s))).toEqual(new Set(["curl/pip/se/0", "curl/pip/se/1"]));
    });

    test("someone standing beside them is unaffected", () => {
      const s = lying("lie", "ne");
      expect(s.draws.filter((d) => d.id === "b").every((d) => !/^(lie|curl)\//.test(d.frame ?? ""))).toBe(true);
    });

    test("under reduced motion they lie on frame 0 and no breath timer runs", () => {
      const s = setup({ reduced: true });
      s.anim.setFrames(frames);
      s.walks.place([{ id: id("a"), at: cellCenter(2, 5), z: 7, seatFacing: "se" }], 0);
      s.anim.set([{ id: id("a"), avatar: 1, lie: "lie" }]);
      s.frame(0);
      expect(lieFrames(s).at(-1)).toBe("lie/pip/se/0");
      expect(s.timers.length).toBe(0);
    });
  });
});

// OME-597 (M7 W2): in full screen the room is hidden, so its render loop stops: nothing is drawn or scheduled while
// paused, and on resume one frame draws everyone where they are now (a walk that ended meanwhile lands at its spot).
describe("animator pause (full screen)", () => {
  test("paused: queued step and breathe timers draw nothing, and new placements schedule nothing", () => {
    const s = setup();
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(0);
    s.walks.place([standAt("a", 5, 8)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]); // walking: a step timer is queued
    const step = s.timers.at(-1);
    s.anim.pause(true);
    expect(s.cleared()).toBeGreaterThan(0);
    const draws = s.draws.length;
    const renders = s.renders();
    s.timers.length = 0;
    step?.fn();
    s.frame(150);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.anim.emote(id("a"), "wave");
    expect(s.draws.length).toBe(draws);
    expect(s.renders()).toBe(renders);
    expect(s.timers.length).toBe(0);
    expect(s.rafs.length).toBe(0);
  });

  test("resume: one frame draws everyone at their current pose, then the usual schedule picks up", () => {
    const s = setup();
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(0);
    s.anim.pause(true);
    s.walks.place([standAt("a", 5, 8)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.anim.pause(false);
    expect(s.rafs.length).toBe(1);
    const renders = s.renders();
    s.draws.length = 0;
    expect(s.frame(5000)).toBe(true);
    expect(s.renders()).toBe(renders + 1);
    expect(s.draws.at(-1)?.pose).toMatchObject({ walking: false, x: cellCenter(5, 8).x, y: cellCenter(5, 8).y });
    // At rest again: the next breathe change is one timer away.
    expect(s.timers.length).toBeGreaterThan(0);
  });

  test("pause(false) when not paused queues nothing", () => {
    const s = setup();
    s.anim.setFrames(frames);
    s.frame(0);
    s.anim.pause(false);
    expect(s.rafs.length).toBe(0);
  });
});

// OME-731 (ADR 0037): in Smooth the room draws every frame while anyone walks (the in-betweens too), one rAF after the
// other; at rest it goes back to the breathe clock. Basic keeps its timer per 150 ms step.
describe("animator: jog (OME-1464)", () => {
  test("Basic: a jog redraws once per 75 ms step, then rests", () => {
    const s = setup();
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(0);
    s.walks.place([{ ...standAt("a", 5, 8), run: true }], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    expect(s.rafs.length).toBe(0);
    expect(s.timers.at(-1)?.ms).toBe(75);
    const before = s.renders();
    let t = 0;
    for (let i = 0; i < 10; i++) {
      const timer = s.timers.at(-1);
      if (timer === undefined || s.draws.at(-1)?.pose.walking === false) break;
      t += timer.ms;
      s.timers.length = 0;
      timer.fn();
      expect(s.frame(t + 5)).toBe(true);
    }
    // Steps at 75, 150, 225, then at rest at 300: four redraws for the tile, as a walk's.
    expect(s.renders() - before).toBe(4);
    expect(s.draws.at(-1)?.pose.walking).toBe(false);
  });
});

describe("animator, Smooth tier", () => {
  test("a walk requests the next frame on every frame until the walker arrives, then waits on the breathe clock", () => {
    const s = setup({ smooth: () => true });
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(0);
    s.walks.place([standAt("a", 5, 8)], 0); // one tile, ne, starts at 0
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    expect(s.rafs.length).toBe(1);
    s.timers.length = 0;
    const before = s.renders();
    const shown = new Set<string | null>();
    let t = 0;
    while (s.rafs.length > 0 && t < 2000) {
      t += 1000 / 60;
      s.frame(t);
      shown.add(s.draws.at(-1)?.frame ?? null);
      if (s.draws.at(-1)?.pose.walking === true) expect(s.timers.length).toBe(0);
    }
    // ~600 ms of walking at 60 Hz, one render per frame, then at rest.
    expect(s.renders() - before).toBeGreaterThanOrEqual(35);
    expect(s.renders() - before).toBeLessThanOrEqual(38);
    expect(s.draws.at(-1)?.pose.walking).toBe(false);
    expect(s.rafs.length).toBe(0);
    expect(s.timers.length).toBe(1);
    for (const k of ["walk/juno/ne/0", "walk8/juno/ne/1", "walk/juno/ne/1", "walk8/juno/ne/3", "walk/juno/ne/2", "walk8/juno/ne/5", "walk/juno/ne/3", "walk8/juno/ne/7"]) expect(shown.has(k)).toBe(true);
  });

  test("dropping to Basic mid-walk goes back to one timer per 150 ms step on the next frame", () => {
    let on = true;
    const s = setup({ smooth: () => on });
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(0);
    s.walks.place([standAt("a", 5, 6)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(17);
    expect(s.rafs.length).toBe(1);
    on = false;
    s.timers.length = 0;
    s.frame(34);
    expect(s.rafs.length).toBe(0);
    expect(s.timers.at(-1)?.ms).toBe(150 - 34);
    expect(s.draws.at(-1)?.frame).toBe("walk/juno/ne/0");
  });

  test("each render reports when its frame started and whether Smooth drew a walk in it (the tier probe)", () => {
    let on = false;
    const s = setup({ smooth: () => on });
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(5);
    expect(s.rendered).toEqual([{ start: 5, walking: false }]);
    s.walks.place([standAt("a", 5, 6)], 5); // starts at 150
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.timers.at(-1)?.fn();
    s.frame(152);
    expect(s.rendered.at(-1)).toEqual({ start: 152, walking: false }); // Basic: a step render, not a Smooth walking one
    on = true;
    s.timers.at(-1)?.fn();
    s.frame(300);
    expect(s.rendered.at(-1)).toEqual({ start: 300, walking: true });
  });

  test("a Smooth walking frame asks walks.walking() once (OME-750: each call makes a Map iterator)", () => {
    const s = setup({ smooth: () => true });
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 5, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.frame(0);
    s.walks.place([standAt("a", 5, 6)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    for (let t = 17; t < 300; t += 17) {
      const before = s.walkingCalls();
      s.frame(t);
      expect(s.draws.at(-1)?.pose.walking).toBe(true);
      expect(s.walkingCalls() - before).toBe(1);
    }
  });
});

// OME-1407: furniture "in use" loops run on the same clock as the walkers: the 150 ms step on Basic, their own frame time on
// Smooth, through one timer then one rAF per frame change; still under reduced motion; nothing scheduled once none runs.
describe("animator: furniture loops", () => {
  /** Fire the pending timer and run its frame at the timer's time; returns that time. */
  const step = (s: ReturnType<typeof setup>, t: number): number => {
    const timer = s.timers.at(-1);
    if (timer === undefined) throw new Error("no timer");
    s.timers.length = 0;
    timer.fn();
    const at = t + timer.ms;
    expect(s.frame(at)).toBe(true);
    return at;
  };

  test("Basic: one frame per 150 ms step, wrapping, whatever the piece's own frame time", () => {
    const s = setup();
    s.anim.setLoops([{ frames: 3, ms: 160 }]);
    expect(s.frame(0)).toBe(true);
    expect(s.loopDraws).toEqual([[0, 0]]);
    expect(s.timers.at(-1)?.ms).toBe(150);
    let t = 0;
    for (let i = 0; i < 3; i++) t = step(s, t);
    expect(s.loopDraws.map(([, f]) => f)).toEqual([0, 1, 2, 0]);
    expect(s.rafs.length).toBe(0); // timers, never a per-frame loop
  });

  test("Smooth: each loop on its own frame time; the next timer is the soonest change", () => {
    const s = setup({ smooth: () => true });
    s.anim.setLoops([
      { frames: 3, ms: 160 },
      { frames: 4, ms: 120 },
    ]);
    s.frame(0);
    expect(s.timers.at(-1)?.ms).toBe(120);
    s.loopDraws.length = 0;
    let t = step(s, 0); // 120
    expect(s.loopDraws).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(s.timers.at(-1)?.ms).toBe(40);
    s.loopDraws.length = 0;
    t = step(s, t); // 160
    expect(t).toBe(160);
    expect(s.loopDraws).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  test("reduced motion: the still frame (-1), no timer", () => {
    const s = setup({ reduced: true });
    s.anim.setLoops([{ frames: 3, ms: 160 }]);
    s.frame(0);
    expect(s.loopDraws).toEqual([[0, -1]]);
    expect(s.timers.length).toBe(0);
  });

  test("no loop left: one frame to draw the change, then nothing is scheduled", () => {
    const s = setup();
    s.anim.setLoops([{ frames: 3, ms: 160 }]);
    s.frame(0);
    s.anim.setLoops([]);
    expect(s.frame(10)).toBe(true);
    expect(s.cleared()).toBeGreaterThan(0);
    expect(s.timers.length).toBe(1); // only the first loop's, cleared
    expect(s.rafs.length).toBe(0);
  });

  test("paused (full screen): nothing drawn or scheduled until resumed", () => {
    const s = setup();
    s.anim.pause(true);
    s.anim.setLoops([{ frames: 3, ms: 160 }]);
    expect(s.rafs.length).toBe(0);
    s.anim.pause(false);
    expect(s.frame(0)).toBe(true);
    expect(s.loopDraws).toEqual([[0, 0]]);
  });
});

// OME-2068 (ADR 0058 §2): ambient loops (the fireplace, the neon sign) run at rest. While one runs, every wake-up lands on
// one shared clock, the walkers' 150 ms step, so the loops and breathing together stay under 8 renders a second.
describe("animator: ambient loops", () => {
  test("two ambient loops and someone breathing: every render on the 150 ms clock, under 7 a second, loops stepping", () => {
    const s = setup({ smooth: () => true });
    s.anim.setFrames(frames);
    s.walks.place([standAt("a", 4, 9)], 0);
    s.anim.set([{ id: id("a"), avatar: 0 }]);
    s.anim.setLoops([
      { frames: 4, ms: 120, ambient: true },
      { frames: 3, ms: 140, ambient: true },
    ]);
    let t = 0;
    s.frame(t);
    const before = s.renders();
    while (t < 4000) {
      const timer = s.timers.at(-1);
      if (timer === undefined) break;
      t += timer.ms;
      expect(t % 150).toBe(0);
      s.timers.length = 0;
      timer.fn();
      s.frame(t);
    }
    expect(t).toBeGreaterThanOrEqual(4000);
    expect(s.renders() - before).toBeLessThanOrEqual(27);
    const fire = new Set(s.loopDraws.filter(([i]) => i === 0).map(([, f]) => f));
    expect(fire).toEqual(new Set([0, 1, 2, 3]));
  });

  test("an ambient loop in the Basic tier still steps on the 150 ms walkers' clock (the room drops ambient loops there)", () => {
    const s = setup();
    s.anim.setLoops([{ frames: 3, ms: 160, ambient: true }]);
    s.frame(0);
    expect(s.timers.at(-1)?.ms).toBe(150);
  });
});

// OME-1425: a door's open frame is a one-frame loop: a state (someone stands there), not motion.
describe("animator: one-frame loops", () => {
  test("drawn at frame 0 on Basic and Smooth, with no timer", () => {
    for (const smooth of [false, true]) {
      const s = setup({ smooth: () => smooth });
      s.anim.setLoops([{ frames: 1, ms: 3_600_000 }]);
      s.frame(0);
      expect(s.loopDraws).toEqual([[0, 0]]);
      expect(s.timers.length).toBe(0);
      expect(s.rafs.length).toBe(0);
    }
  });

  test("still under reduced motion: opening is not motion", () => {
    const s = setup({ reduced: true });
    s.anim.setLoops([{ frames: 1, ms: 3_600_000 }, { frames: 3, ms: 160 }]);
    s.frame(0);
    expect(s.loopDraws).toEqual([[0, 0], [1, -1]]);
    expect(s.timers.length).toBe(0);
  });

  test("beside a longer loop it adds no wake-up of its own", () => {
    const s = setup();
    s.anim.setLoops([{ frames: 1, ms: 3_600_000 }, { frames: 3, ms: 160 }]);
    s.frame(0);
    expect(s.timers.at(-1)?.ms).toBe(150);
  });
});

// OME-1520: the cat walks on the animator's loop, so it shares the walkers' renders instead of adding its own.
describe("animator: walking props (the cat)", () => {
  test("a walking cat with nobody else walking steps once per 150 ms on the shared clock, then stops scheduling", () => {
    const drawn: number[] = [];
    const s = setup({ props: (t) => (drawn.push(t), t < 600) });
    s.anim.set([]);
    s.anim.wake();
    expect(s.frame(0)).toBe(true);
    let t = 0;
    for (let i = 0; i < 10 && s.timers.length > 0; i++) {
      const timer = s.timers.at(-1);
      if (timer === undefined) break;
      s.timers.length = 0;
      t += timer.ms;
      timer.fn();
      expect(s.frame(t)).toBe(true);
    }
    expect(drawn).toEqual([0, 0, 150, 300, 450, 600]);
    expect(s.timers.length).toBe(0); // at rest: nothing scheduled
    expect(s.rafs.length).toBe(0);
  });

  test("Smooth: a walking cat asks for the next frame on every frame, like a walker", () => {
    const s = setup({ smooth: () => true, props: (t) => t < 100 });
    s.anim.set([]);
    s.anim.wake();
    expect(s.frame(0)).toBe(true);
    expect(s.frame(16)).toBe(true);
    expect(s.frame(120)).toBe(true);
    expect(s.rafs.length).toBe(0);
  });
});
