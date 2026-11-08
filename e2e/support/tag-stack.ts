// The name tags as painted (OME-2307): the room handle's `tags()` (apps/web/src/main.ts `window.__omega`), not DOM boxes,
// since the tags are drawn on the room canvas and only transparent targets stay in the DOM.
import type { Page } from "@playwright/test";
import * as v from "valibot";

const RectSchema = v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number() });
/** `led`: stacked off its owner's head, it wears a leader pip (OME-2172). */
const TagSchema = v.object({ member: v.string(), text: v.string(), rect: RectSchema, led: v.boolean() });
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

/** Hide (or show again) the painted tags, for a shot of the room without them; resolves once the canvas has redrawn. */
export async function hideTags(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(async (hidden) => {
    const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
    const hide: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "hideTags") : null;
    if (typeof hide !== "function") throw new Error("no hideTags");
    Reflect.apply(hide, room, [hidden]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, hidden);
}

const BubbleSchema = v.object({ member: v.string(), text: v.string(), rect: RectSchema });
export type RoomBubble = v.InferOutput<typeof BubbleSchema>;

/** Every chat bubble painted in the room (OME-2307 3c): the room handle's `bubbles()`, in CSS px from the viewport. */
export async function roomBubbles(page: Page): Promise<RoomBubble[]> {
  const raw = await page.evaluate(() => {
    const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
    const bubbles: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "bubbles") : null;
    return typeof bubbles === "function" ? (Reflect.apply(bubbles, room, []) as unknown) : null;
  });
  return v.parse(v.array(BubbleSchema), raw);
}

/** Hide the painted bubbles (or show them again) and wait two frames for the canvas to draw. */
export async function hideBubbles(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(async (hidden) => {
    const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
    const hide: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "hideBubbles") : null;
    if (typeof hide !== "function") throw new Error("no hideBubbles");
    Reflect.apply(hide, room, [hidden]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, hidden);
}
