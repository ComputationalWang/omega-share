// The name tags as painted (OME-2307): the room handle's `tags()` (apps/web/src/main.ts `window.__omega`), not DOM boxes,
// since the tags are drawn on the room canvas and only transparent targets stay in the DOM.
import type { Page } from "@playwright/test";
import * as v from "valibot";

const RectSchema = v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number() });
const TagSchema = v.object({ member: v.string(), text: v.string(), rect: RectSchema });
/** A painted tag's box, in CSS px from the viewport's top left (Playwright `boundingBox` shape). */
export type TagRect = v.InferOutput<typeof RectSchema>;
export type RoomTag = v.InferOutput<typeof TagSchema>;

/** Every name tag in the room, the local avatar's included. */
export async function roomTags(page: Page): Promise<RoomTag[]> {
  const raw = await page.evaluate(() => {
    const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
    const tags: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "tags") : null;
    return typeof tags === "function" ? (Reflect.apply(tags, room, []) as unknown) : null;
  });
  return v.parse(v.array(TagSchema), raw);
}

/** The box of the tag whose text matches `text` (the first, as `locator.filter({ hasText })` would), or null. */
export async function tagBox(page: Page, text?: string | RegExp): Promise<TagRect | null> {
  const hit = (t: RoomTag): boolean => text === undefined || (typeof text === "string" ? t.text.includes(text) : text.test(t.text));
  return (await roomTags(page)).find(hit)?.rect ?? null;
}
