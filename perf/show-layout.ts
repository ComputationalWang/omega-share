// Show `layout` instead of the room's own one, in the page: every room `snapshot` the page's socket gets is rewritten
// before the app reads it. The server keeps its own layout (seats and walks are checked against it); seat i renders on
// the shown layout's seat i. Not through routeWebSocket: a routed socket hands every frame over the driver, which cost
// the observer ~1 ms on its worst frames and made a furnished room look dearer than it is (OME-1448).
import { readFileSync } from "node:fs";
import type { BrowserContext } from "@playwright/test";
import * as v from "valibot";
import { RoomLayoutSchema, type RoomLayout } from "@omega/shared";

/** `assets/presets/<id>.json`, parsed. */
export function presetFile(id: string): RoomLayout {
  if (!/^[a-z]{1,12}$/.test(id)) throw new Error(`not a preset id: ${JSON.stringify(id)}`);
  return v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL(`../assets/presets/${id}.json`, import.meta.url), "utf8")));
}

export async function showLayout(context: BrowserContext, layout: RoomLayout): Promise<void> {
  await context.addInitScript((shown) => {
    const onmessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      configurable: true,
      get(this: WebSocket): unknown {
        return onmessage?.get?.call(this);
      },
      set(this: WebSocket, fn: ((ev: MessageEvent<unknown>) => unknown) | null) {
        const room = /\/rooms\/[^/]+\/ws$/.test(this.url);
        onmessage?.set?.call(
          this,
          fn === null || !room
            ? fn
            : (ev: MessageEvent<unknown>) => {
                if (typeof ev.data !== "string" || !ev.data.includes('"snapshot"')) return fn.call(this, ev);
                const msg: unknown = JSON.parse(ev.data);
                const r: unknown = typeof msg === "object" && msg !== null && Reflect.get(msg, "type") === "snapshot" ? Reflect.get(msg, "room") : null;
                if (typeof r !== "object" || r === null) return fn.call(this, ev);
                Reflect.set(r, "layout", shown);
                return fn.call(this, new MessageEvent("message", { data: JSON.stringify(msg) }));
              },
        );
      },
    });
  }, layout);
}
