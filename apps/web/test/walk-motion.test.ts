import { describe, expect, test } from "bun:test";
import { AVATAR_COUNT } from "@omega/shared";
import { DIRS, cycleFrame, parseMotion } from "../src/walk/motion";

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
    const named = [...m.walk.flat(2), ...m.rest.flatMap((r) => [...r.idle, ...r.sit].flatMap((c) => c.frames))];
    expect(named.length).toBe(AVATAR_COUNT * 4 * 4 + AVATAR_COUNT * 8 * 2);
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
