// The room handle's dev-build hooks (apps/web/src/main.ts `window.__omega`): the draw order and our own member id.
import type { Page } from "@playwright/test";
import * as v from "valibot";

async function debugCall(page: Page, path: "scene" | "self"): Promise<unknown> {
  return page.evaluate((path) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    if (typeof room !== "object" || room === null) return null;
    if (path === "scene") {
      const scene: unknown = Reflect.get(room, "scene");
      return typeof scene === "function" ? (Reflect.apply(scene, room, []) as unknown) : null;
    }
    const state: unknown = Reflect.get(room, "state");
    const s: unknown = typeof state === "function" ? Reflect.apply(state, room, []) : null;
    return typeof s === "object" && s !== null ? (Reflect.get(s, "self") as unknown) : null;
  }, path);
}

/** Draw order of the room scene, back to front: `floor`, `seat:N`, `furniture/<frame>`, `avatar:<id>`. */
export const scene = async (page: Page): Promise<string[]> => v.parse(v.array(v.string()), await debugCall(page, "scene"));
/** Our own member id. */
export const selfId = async (page: Page): Promise<string> => v.parse(v.string(), await debugCall(page, "self"));
/** Avatars walk to a seat before they take its depth (OME-408, 600 ms a tile); poll seated checks at least this long. */
export const WALK_SETTLE_MS = 15_000;
/** True once `avatar:<self>` is drawn between `furniture/<piece>/back` and `.../front`. */
export async function seatedBetween(page: Page, self: string, piece: string): Promise<boolean> {
  const order = await scene(page);
  const back = order.indexOf(`furniture/${piece}/back`);
  const me = order.indexOf(`avatar:${self}`);
  const front = order.indexOf(`furniture/${piece}/front`);
  return back >= 0 && back < me && me < front;
}
