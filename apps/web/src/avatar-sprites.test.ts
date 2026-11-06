// The landing draws the four avatars from avatars.png with CSS (no Pixi, no JSON fetch on `/`, OME-2305). Its
// background positions are avatars.json's <name>/idle/se/0 rectangles at 2× and 3×: this holds the two together.
import { expect, test } from "bun:test";
import avatars from "../../../assets/avatars/avatars.json";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
const NAMES = ["juno", "pip", "mo", "kiki"] as const;

test("the entry's sprite rectangles are avatars.json's idle/se/0 frames at 2× and 3×", () => {
  const frames: Record<string, { frame: { x: number; y: number; w: number; h: number } } | undefined> = avatars.frames;
  NAMES.forEach((name, id) => {
    const f = frames[`${name}/idle/se/0`]?.frame;
    expect(f).toBeDefined();
    if (f === undefined) return;
    expect([f.x, f.w, f.h]).toEqual([0, 32, 64]);
    for (const k of [2, 3]) {
      expect(css).toContain(`width: ${String(f.w * k)}px; height: ${String(f.h * k)}px`);
      if (id > 0) expect(css).toContain(`.welcome .a${String(id)} .avatar-sprite { background-position: 0 ${String(-f.y * k)}px; }`);
    }
  });
});
