// The hover cursor as painted (OME-2307): the room handle's `cursor()` (apps/web/src/main.ts `window.__omega`), a sprite on the
// room canvas, not DOM.
import type { Page } from "@playwright/test";
import * as v from "valibot";

const CursorSchema = v.nullable(v.object({ kind: v.picklist(["free", "mine", "taken"]), rect: v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() }) }));
export type RoomCursor = v.InferOutput<typeof CursorSchema>;

/** The cursor now (box in CSS px from the viewport's top left), or null when hidden. */
export async function roomCursor(page: Page): Promise<RoomCursor> {
  const raw = await page.evaluate(() => {
    const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "cursor") : null;
    return typeof f === "function" ? (Reflect.apply(f, room, []) as unknown) : null;
  });
  return v.parse(CursorSchema, raw);
}
