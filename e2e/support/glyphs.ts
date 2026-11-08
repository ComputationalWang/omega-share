// The reaction glyphs as painted (OME-2307): the room handle's `reactions()` (apps/web/src/main.ts `window.__omega`), not DOM
// nodes, since the glyphs are sprites on the room canvas.
import type { Page } from "@playwright/test";
import * as v from "valibot";

const RectSchema = v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number() });
const GlyphSchema = v.object({ kind: v.picklist(["heart", "laugh", "wow", "clap"]), rect: RectSchema });
export type RoomGlyph = v.InferOutput<typeof GlyphSchema>;

/** Every glyph live now, its box in CSS px from the viewport's top left. */
export async function roomGlyphs(page: Page): Promise<RoomGlyph[]> {
  const raw = await page.evaluate(() => {
    const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "reactions") : null;
    return typeof f === "function" ? (Reflect.apply(f, room, []) as unknown) : null;
  });
  return v.parse(v.array(GlyphSchema), raw);
}

/** Counts, from now on, every glyph that appears (a glyph lives 0.9 s: sampled every 20 ms, a poll alone could miss it). */
export async function watchGlyphs(page: Page): Promise<void> {
  await page.evaluate(() => {
    let seen = 0;
    let prev = 0;
    Reflect.set(window, "__glyphsSeen", () => seen);
    setInterval(() => {
      const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
      const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "reactions") : null;
      const now = typeof f === "function" ? (Reflect.apply(f, room, []) as unknown[]).length : 0;
      if (now > prev) seen += now - prev;
      prev = now;
    }, 20);
  });
}

export const glyphsSeen = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const f: unknown = Reflect.get(window, "__glyphsSeen");
    return typeof f === "function" ? Number(Reflect.apply(f, window, [])) : 0;
  });
