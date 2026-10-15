// The Halloween theme's sheet (assets/themes/halloween, CC BY-SA 4.0, OME-1185): wall and window decor, bat frames and a
// witch hat per avatar frame. Its own chunk, fetched only while Halloween is active.
import * as v from "valibot";
import type { Texture } from "pixi.js";
import json from "../../../../assets/themes/halloween/halloween.json";
import pngUrl from "../../../../assets/themes/halloween/halloween.png?url";
import { loadSheet } from "../atlas-sheet";
import { MOTIONS, type ThemeAtlas } from "./atlas";
import { MAX_EFFECT_SPRITES } from "./effect";

const XY = v.object({ x: v.number(), y: v.number() });

/** The theme sheet's manifest (assets/README.md "themes"): frames, then `meta.omega` decor, effect and hat prefix. */
export const ThemeManifestSchema = v.object({
  frames: v.record(v.string(), v.object({ frame: v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() }), anchor: XY })),
  meta: v.object({
    omega: v.object({
      decor: v.array(v.object({ key: v.string(), on: v.string() })),
      effect: v.object({ frames: v.pipe(v.array(v.string()), v.minLength(1)), ms: v.pipe(v.number(), v.minValue(16)), max: v.pipe(v.number(), v.integer(), v.minValue(0)) }),
      hat: v.object({ prefix: v.string() }),
    }),
  }),
});

export async function loadHalloween(): Promise<ThemeAtlas> {
  const m = v.parse(ThemeManifestSchema, json);
  const sheet = await loadSheet(m.frames, pngUrl);
  const { effect, hat, decor } = m.meta.omega;
  const frames = effect.frames.flatMap((k) => {
    const f = m.frames[k];
    return f === undefined ? [] : [{ sx: f.frame.x, sy: f.frame.y, w: f.frame.w, h: f.frame.h, ox: Math.round(f.anchor.x * f.frame.w), oy: Math.round(f.anchor.y * f.frame.h) }];
  });
  /** Per avatar frame key: its hat (or none). Filled once per key, so a walking frame never builds a string. */
  const hats = new Map<string, Texture | null>();
  return {
    ...sheet,
    id: "halloween",
    decor,
    effect: { image: sheet.image, frames, ms: effect.ms, max: Math.min(effect.max, MAX_EFFECT_SPRITES), motion: MOTIONS.halloween },
    hat(frame) {
      let t = hats.get(frame);
      if (t === undefined) {
        t = sheet.texture(hat.prefix + frame) ?? null;
        hats.set(frame, t);
      }
      return t ?? undefined;
    },
  };
}
