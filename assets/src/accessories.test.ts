// Head accessories (OME-1388): one lazy PNG-8 sheet, each accessory a hat for every avatar frame key, in the theme hat's manifest shape.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (f: string): Buffer => readFileSync(join(ROOT, f));
interface Atlas {
  frames: Record<string, unknown>;
  meta: { omega: { accessories: Record<string, { prefix: string; count: number }> } };
}
const a = JSON.parse(read("accessories/accessories.json").toString("utf8")) as Atlas;
const avatarKeys = ["avatars/avatars.json", "avatars/motion.json", "avatars/expressions.json", "avatars/watching.json"]
  .flatMap((f) => Object.keys((JSON.parse(read(f).toString("utf8")) as Atlas).frames))
  .filter((k) => !k.startsWith("emote/"));

test("eight accessories, each with a hat for every avatar frame key", () => {
  expect(Object.keys(a.meta.omega.accessories).sort()).toEqual(["beanie", "bow", "cap", "crown", "flower", "halo", "headphones", "partyhat"]);
  for (const [id, h] of Object.entries(a.meta.omega.accessories)) {
    expect(h.prefix).toBe(`${id}/hat/`);
    expect(avatarKeys.filter((k) => !a.frames[`${h.prefix}${k}`])).toEqual([]);
    expect(h.count).toBe(avatarKeys.length);
  }
});

test("the sheet is PNG-8 and at most 512×256", () => {
  const png = read("accessories/accessories.png");
  expect(png.readUInt32BE(16)).toBeLessThanOrEqual(512);
  expect(png.readUInt32BE(20)).toBeLessThanOrEqual(256);
  expect([png[24], png[25]]).toEqual([8, 3]);
});

// OME-1409: Pip's beanie and Mo's bucket hat come off under a worn-over accessory, so the web swaps in bare-head frames.
interface Bare {
  frames: Record<string, { frame: { w: number; h: number }; anchor: { x: number; y: number } }>;
  meta: { omega: { bare: { prefix: string; avatars: string[]; accessories: string[] } } };
}
const bare = JSON.parse(read("accessories/bare.json").toString("utf8")) as Bare;

test("bare-head frames for Pip and Mo, every frame key, in the avatar cell shape", () => {
  const { prefix, avatars, accessories } = bare.meta.omega.bare;
  expect(prefix).toBe("bare/");
  expect(avatars).toEqual(["pip", "mo"]);
  expect(accessories).toEqual(["partyhat", "crown", "headphones", "cap", "bow"]);
  const keys = avatarKeys.filter((k) => /(^|\/)(pip|mo)\//.test(k));
  expect(keys.length).toBe(228);
  expect(keys.filter((k) => !bare.frames[`${prefix}${k}`])).toEqual([]);
  expect(Object.keys(bare.frames).length).toBe(228);
  for (const f of Object.values(bare.frames)) {
    expect([f.frame.w, f.frame.h]).toEqual([32, 64]);
    expect(f.anchor).toEqual({ x: 0.5, y: 61 / 64 });
  }
});

test("the bare sheet is PNG-8 and small", () => {
  const png = read("accessories/bare.png");
  expect([png[24], png[25]]).toEqual([8, 3]);
  expect(png.length).toBeLessThan(16 * 1024);
});

// OME-1530: the web swaps each avatar's tint and hair slots in its hat overlays, so the new four keep off those ramps.
test("cap, flower, bow and halo use no swatch or hair ramp", async () => {
  const { ACCESSORIES } = await import("./accessories");
  const { AVATARS } = await import("./avatars");
  const swapped = new Set(AVATARS.flatMap((x) => [x.swatch, ...Object.values(x.roles).filter((r) => r.ramp.startsWith("hair")).map((r) => r.ramp)]));
  const used = ACCESSORIES.slice(4).flatMap((x) => Object.values(x.hat.roles).map((r) => r.ramp));
  expect(used.filter((r) => swapped.has(r))).toEqual([]);
});
