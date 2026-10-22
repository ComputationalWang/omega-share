// Holiday themes (OME-1185, OME-1187): every shipped theme atlas has a hat for every avatar frame, stays under its 40 KB cap,
// keeps its effect sprites inside their size limit and attaches decor only to wall frames.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = join(import.meta.dir, "..");
const read = (f: string): Buffer => readFileSync(join(ROOT, f));
interface Atlas {
  frames: Record<string, { frame: { w: number; h: number } }>;
  meta: { omega: { theme: string; decor: { key: string; on: string }[]; effect: { frames: string[] }; hat: { prefix: string; count: number } } };
}
const atlas = (id: string): Atlas => JSON.parse(read(`themes/${id}/${id}.json`).toString("utf8")) as Atlas;
const avatarKeys = ["avatars/avatars.json", "avatars/motion.json", "avatars/expressions.json", "avatars/watching.json"]
  .flatMap((f) => Object.keys((JSON.parse(read(f).toString("utf8")) as Atlas).frames))
  .filter((k) => !k.startsWith("emote/"));
const WALLS = new Set(["wall/l/window0", "wall/l/window1", "wall/r/poster0", "wall/r/poster1", "wall/corner", "wall/l/end", "wall/r/end", "wall/l", "wall/r"]);
// Plan OME-1140 / issue OME-1187: the largest effect sprite each theme may ship, outline included.
const EFFECT_MAX: Record<string, number> = { halloween: 16, sinterklaas: 8, christmas: 6, valentines: 8, easter: 6 };

describe.each(Object.keys(EFFECT_MAX))("theme %s", (id) => {
  const a = atlas(id);
  test("a hat for every avatar frame key", () => {
    const missing = avatarKeys.filter((k) => !a.frames[`${a.meta.omega.hat.prefix}${k}`]);
    expect(missing).toEqual([]);
    expect(a.meta.omega.hat.count).toBe(avatarKeys.length);
  });
  test("≤ 40 KB gzipped (png as stored + json gz)", () => {
    expect(read(`themes/${id}/${id}.png`).length + gzipSync(read(`themes/${id}/${id}.json`), { level: 9 }).length).toBeLessThanOrEqual(40 * 1024);
  });
  test("effect sprites fit their size limit", () => {
    for (const k of a.meta.omega.effect.frames) {
      const f = a.frames[k];
      expect(f).toBeDefined();
      expect(Math.max(f?.frame.w ?? Infinity, f?.frame.h ?? Infinity)).toBeLessThanOrEqual(EFFECT_MAX[id] ?? 0);
    }
  });
  test("decor only on walls and windows, every key packed", () => {
    for (const d of a.meta.omega.decor) {
      expect(WALLS.has(d.on)).toBe(true);
      expect(a.frames[d.key]).toBeDefined();
    }
  });
});
