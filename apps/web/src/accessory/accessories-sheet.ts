// The head accessories sheet (assets/accessories, CC BY-SA 4.0, OME-1388): each accessory is a hat per avatar frame, in
// the theme sheet's hat format. Parsed here at the boundary; the room view imports this chunk only once someone wears one.
import * as v from "valibot";
import type { Texture } from "pixi.js";
import { once } from "../atlas-sheet";
import { tintableSheets, type TintableSheets } from "../walk/tint-sheets";
import json from "../../../../assets/accessories/accessories.json";
import pngUrl from "../../../../assets/accessories/accessories.png?url";
import { ACCESSORY_IDS } from "./hat";

const XY = v.object({ x: v.number(), y: v.number() });
/** `bare`: Pip and Mo take their own headwear off under it (bare-sheet.ts). */
const Hat = v.object({ prefix: v.string(), bare: v.boolean() });

/** assets/README.md "Head accessories": frames, then `meta.omega.accessories[id]` with the theme manifest's `hat` shape. */
export const AccessoryManifestSchema = v.object({
  frames: v.record(v.string(), v.object({ frame: v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() }), anchor: XY })),
  meta: v.object({ omega: v.object({ accessories: v.object({ partyhat: Hat, crown: Hat, headphones: Hat, beanie: Hat }) }) }),
});

export interface AccessoryAtlas extends Pick<TintableSheets, "ready" | "loadTint"> {
  /**
   * Accessory `accessory`'s hat over an avatar frame at the same floor point, or none (0, or no hat for that frame). The hat
   * redraws hair around itself in the hair slots: `avatar`'s copy in `hair` (OME-1438) once `loadTint(avatar, 0, hair)` resolved.
   */
  hat(accessory: number, avatarFrame: string, avatar?: number, hair?: number): Texture | undefined;
}

export async function loadAccessorySheet(json: unknown, pngUrl: string): Promise<AccessoryAtlas> {
  const m = v.parse(AccessoryManifestSchema, json);
  // Hats never take a shirt tint (their colours aren't the avatar's): only the hair look, called with tint 0.
  const sheet = await tintableSheets([pngUrl], [m.frames]);
  const prefixes = ACCESSORY_IDS.map((id) => m.meta.omega.accessories[id].prefix);
  /** Per accessory, per avatar frame key: its hat's key (or none). Filled once per key, so a walking frame never builds a string. */
  const hats = prefixes.map(() => new Map<string, string | null>());
  return {
    ready: sheet.ready,
    loadTint: sheet.loadTint,
    hat(accessory, frame, avatar = 0, hair = 0) {
      const prefix = prefixes[accessory - 1];
      const cache = hats[accessory - 1];
      if (prefix === undefined || cache === undefined) return undefined;
      let k = cache.get(frame);
      if (k === undefined) {
        k = m.frames[prefix + frame] === undefined ? null : prefix + frame;
        cache.set(frame, k);
      }
      return k === null ? undefined : sheet.texture(k, avatar, 0, hair);
    },
  };
}

/** Load once; a failed load is forgotten so a later wearer can retry. */
export const loadAccessories = once(() => loadAccessorySheet(json, pngUrl));
