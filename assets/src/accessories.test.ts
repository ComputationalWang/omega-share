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
const avatarKeys = ["avatars/avatars.json", "avatars/motion.json", "avatars/expressions.json"]
  .flatMap((f) => Object.keys((JSON.parse(read(f).toString("utf8")) as Atlas).frames))
  .filter((k) => !k.startsWith("emote/"));

test("four accessories, each with a hat for every avatar frame key", () => {
  expect(Object.keys(a.meta.omega.accessories).sort()).toEqual(["beanie", "crown", "headphones", "partyhat"]);
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
