import { describe, expect, test } from "bun:test";
import { AVATAR_COUNT } from "@omega/shared";
import { DIRS, cycleFrame, oneShotFrame, parseMotion } from "../src/walk/motion";

// OME-408: set (d) motion atlas (ADR 0010). Parsed with Valibot at load; every frame a walk or breathe uses must exist
// in one of the two sheets (breathe frame 0 is the set (a) pose in avatars.json).

const motion: unknown = await Bun.file(new URL("../../../assets/avatars/motion.json", import.meta.url)).json();
const avatars: unknown = await Bun.file(new URL("../../../assets/avatars/avatars.json", import.meta.url)).json();

const clone = (x: unknown): Record<string, unknown> => structuredClone(x) as Record<string, unknown>;

describe("parseMotion", () => {
  const m = parseMotion(motion, avatars);

  test("one entry per avatar index, in avatars.json order", () => {
    expect(m.walk.length).toBe(AVATAR_COUNT);
    expect(m.walk[0]?.[DIRS.indexOf("se")]).toEqual(["walk/juno/se/0", "walk/juno/se/1", "walk/juno/se/2", "walk/juno/se/3"]);
    expect(m.walk[3]?.[DIRS.indexOf("nw")]?.[2]).toBe("walk/kiki/nw/2");
  });

  test("rest is the breathe cycle per pose and direction, starting on the set (a) pose", () => {
    expect(m.rest[1]?.sit[DIRS.indexOf("ne")]).toEqual({ frames: ["pip/sit/ne/0", "breathe/pip/sit/ne/1"], ms: [1400, 1000] });
    expect(m.rest[2]?.idle[DIRS.indexOf("sw")]?.frames[0]).toBe("mo/idle/sw/0");
  });

  test("every frame it names exists in one of the sheets", () => {
    const frames = new Set([
      ...Object.keys((motion as { frames: object }).frames),
      ...Object.keys((avatars as { frames: object }).frames),
    ]);
    const named = [...m.walk.flat(2), ...m.walk8.flat(2), ...m.rest.flatMap((r) => [...r.idle, ...r.sit].flatMap((c) => c.frames))];
    expect(named.length).toBe(AVATAR_COUNT * 4 * 4 + AVATAR_COUNT * 4 * 8 + AVATAR_COUNT * 8 * 2);
    for (const k of named) expect(frames.has(k)).toBe(true);
  });

  test("refuses a sheet whose breathe names a frame that isn't there", () => {
    const bad = clone(motion);
    const meta = bad["meta"] as { omega: { anims: Record<string, { frames: string[] }> } };
    const anim = meta.omega.anims["breathe/juno/sit/ne"];
    if (anim) anim.frames[1] = "breathe/juno/sit/ne/9";
    expect(() => parseMotion(bad, avatars)).toThrow();
  });

  test("refuses a walk timing other than the one walks.ts moves at", () => {
    const bad = clone(motion);
    (bad["meta"] as { omega: { walk: { frameMs: number } } }).omega.walk.frameMs = 100;
    expect(() => parseMotion(bad, avatars)).toThrow();
  });

  // OME-731 (ADR 0037): the Smooth tier's walk is set (l)'s 8-frame cycle at 75 ms; its even frames are the 4-frame keys.
  test("walk8 is the 8-frame cycle per avatar and direction, the in-betweens on the odd frames", () => {
    expect(m.walk8.length).toBe(AVATAR_COUNT);
    expect(m.walk8[0]?.[DIRS.indexOf("se")]).toEqual([
      "walk/juno/se/0", "walk8/juno/se/1", "walk/juno/se/1", "walk8/juno/se/3", "walk/juno/se/2", "walk8/juno/se/5", "walk/juno/se/3", "walk8/juno/se/7",
    ]);
    for (const [a, dirs] of m.walk8.entries()) for (const [d, cycle] of dirs.entries()) expect(cycle.filter((_, i) => i % 2 === 0)).toEqual([...(m.walk[a]?.[d] ?? [])]);
  });

  test("refuses a walk8 timing other than 75 ms a frame", () => {
    const bad = clone(motion);
    (bad["meta"] as { omega: { walk8: { frameMs: number } } }).omega.walk8.frameMs = 100;
    expect(() => parseMotion(bad, avatars)).toThrow();
    const ms = clone(motion);
    const anim = (ms["meta"] as { omega: { anims: Record<string, { ms: number[] }> } }).omega.anims["walk8/pip/ne"];
    if (anim) anim.ms[3] = 150;
    expect(() => parseMotion(ms, avatars)).toThrow();
  });

  test("refuses a walk8 whose even frames aren't the 4-frame walk's (switching tiers mid-stride would pop)", () => {
    const bad = clone(motion);
    const anim = (bad["meta"] as { omega: { anims: Record<string, { frames: string[] }> } }).omega.anims["walk8/mo/sw"];
    if (anim) anim.frames[2] = "walk8/mo/sw/3";
    expect(() => parseMotion(bad, avatars)).toThrow();
  });

  test("refuses a sheet without a walk8 for some avatar and direction", () => {
    const bad = clone(motion);
    delete (bad["meta"] as { omega: { anims: Record<string, unknown> } }).omega.anims["walk8/kiki/nw"];
    expect(() => parseMotion(bad, avatars)).toThrow();
  });

  // OME-415: wave and the emote stickers are one-shots (loop false), named in meta.omega.anims.
  test("wave is a one-shot per avatar, pose and direction: 6 × 160 ms", () => {
    const w = m.wave[0]?.sit[DIRS.indexOf("ne")];
    expect(w).toEqual({
      frames: ["wave/juno/sit/ne/0", "wave/juno/sit/ne/1", "wave/juno/sit/ne/0", "wave/juno/sit/ne/1", "wave/juno/sit/ne/0", "wave/juno/sit/ne/1"],
      ms: [160, 160, 160, 160, 160, 160],
    });
    expect(m.wave[3]?.idle[DIRS.indexOf("se")]?.frames[0]).toBe("wave/kiki/idle/se/0");
  });

  test("every sticker emote is a one-shot of its own frames, about 1.3 s", () => {
    expect(m.emote.heart).toEqual({
      frames: ["emote/heart/0", "emote/heart/1", "emote/heart/2", "emote/heart/1", "emote/heart/2", "emote/heart/1", "emote/heart/0"],
      ms: [80, 160, 200, 200, 200, 400, 80],
    });
    expect(Object.keys(m.emote).sort()).toEqual(["clap", "exclaim", "heart", "laugh", "question"]);
  });

  test("refuses a sheet without a wave for some avatar, pose and direction", () => {
    const bad = clone(motion);
    delete (bad["meta"] as { omega: { anims: Record<string, unknown> } }).omega.anims["wave/pip/idle/sw"];
    expect(() => parseMotion(bad, avatars)).toThrow();
  });

  test("refuses an emote whose timing doesn't match its frames", () => {
    const bad = clone(motion);
    const anim = (bad["meta"] as { omega: { anims: Record<string, { ms: number[] }> } }).omega.anims["emote/clap"];
    anim?.ms.pop();
    expect(() => parseMotion(bad, avatars)).toThrow();
  });

  test("refuses junk", () => {
    expect(() => parseMotion({}, avatars)).toThrow();
    expect(() => parseMotion(motion, null)).toThrow();
  });
});

describe("cycleFrame", () => {
  test("which frame of a looping cycle shows after t ms, and how long until it changes", () => {
    const ms = [1400, 1000];
    expect([0, 1399, 1400, 2399, 2400, 2400 * 5 + 1500].map((t) => cycleFrame(ms, t).index)).toEqual([0, 0, 1, 1, 0, 1]);
    expect(cycleFrame(ms, 0).nextIn).toBe(1400);
    expect(cycleFrame(ms, 1500).nextIn).toBe(900);
    expect(cycleFrame(ms, -100)).toEqual({ index: 0, nextIn: 1500 });
  });
});

describe("oneShotFrame", () => {
  test("which frame a one-shot shows after t ms and how long until it changes; -1 once it's over", () => {
    const ms = [80, 160, 200];
    expect([0, 79, 80, 239, 240, 439].map((t) => oneShotFrame(ms, t).index)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(oneShotFrame(ms, 100).nextIn).toBe(140);
    expect(oneShotFrame(ms, 439).nextIn).toBe(1);
    expect(oneShotFrame(ms, 440)).toEqual({ index: -1, nextIn: Infinity });
    expect(oneShotFrame(ms, 10_000).index).toBe(-1);
    expect(oneShotFrame(ms, -50)).toEqual({ index: -1, nextIn: 50 });
  });
});
