// A holiday theme's art (OME-1186, ADR 0052). room-view.ts imports this module only while a theme is active, and each
// theme's sheet is its own chunk below it, so the landing page and initial JS never carry any of it.
import type { Texture } from "pixi.js";
import type { Sheet } from "../atlas-sheet";
import type { DecorPiece } from "./decor";
import type { EffectFrame, EffectMotion } from "./effect";
import type { ThemeId } from "./periods";
import type { TintableSheets } from "../walk/tint-sheets";

export interface ThemeEffect {
  /** The theme's one sheet, drawn straight onto the effect canvas. */
  readonly image: CanvasImageSource;
  /** Animation frames in it; they face right. */
  readonly frames: readonly EffectFrame[];
  /** ms per frame. */
  readonly ms: number;
  /** How many sprites (≤ MAX_EFFECT_SPRITES). */
  readonly max: number;
  readonly motion: EffectMotion;
}

export interface ThemeAtlas extends Sheet, Pick<TintableSheets, "ready" | "loadTint"> {
  readonly id: ThemeId;
  readonly decor: readonly DecorPiece[];
  readonly effect: ThemeEffect;
  /**
   * The hat drawn over an avatar frame (`breathe/juno/idle/se/0`, …) at the same floor point, or none for that frame; in
   * `avatar`'s `hair` copy (OME-1438) once `loadTint(avatar, 0, hair)` resolved.
   */
  hat(avatarFrame: string, avatar?: number, hair?: number): Texture | undefined;
}

/**
 * Where every theme's particles drift: the band of the two back walls and the window, not the whole stage. The
 * effect's overlay covers only this band (plus margins), at most a third of the stage (QA OME-1211, ADR 0052).
 */
const BAND = { x: 160, y: 40, w: 640, h: 200 };

/** How each theme's particles drift (plan OME-1140: bats cross the back wall, the rest fall, rise or blow). */
export const MOTIONS: Readonly<Record<ThemeId, EffectMotion>> = {
  halloween: { area: BAND, vx: [30, 55], vy: [-6, 6], flipX: true },
  sinterklaas: { area: BAND, vx: [-6, 6], vy: [20, 35], flipX: false },
  christmas: { area: BAND, vx: [-10, 10], vy: [22, 45], flipX: false },
  valentine: { area: BAND, vx: [-8, 8], vy: [-22, -12], flipX: false },
  easter: { area: BAND, vx: [14, 28], vy: [8, 18], flipX: true },
};

/** Each theme's sheet folder under assets/themes (Valentine's is plural there). */
const SHEET_DIRS: Readonly<Record<ThemeId, string>> = { halloween: "halloween", sinterklaas: "sinterklaas", christmas: "christmas", valentine: "valentines", easter: "easter" };

/** Load once per theme; a failed load is forgotten so a later room can retry. */
const loading = new Map<ThemeId, Promise<ThemeAtlas>>();

export function loadTheme(id: ThemeId): Promise<ThemeAtlas> {
  let p = loading.get(id);
  if (p === undefined) {
    // Lazy globs: every theme's manifest and PNG URL is its own chunk, fetched only for the theme shown.
    const jsons = import.meta.glob<unknown>("../../../../assets/themes/*/*.json", { import: "default" });
    const pngs = import.meta.glob<string>("../../../../assets/themes/*/*.png", { query: "?url", import: "default" });
    const base = `../../../../assets/themes/${SHEET_DIRS[id]}/${SHEET_DIRS[id]}`;
    const json = jsons[`${base}.json`];
    const png = pngs[`${base}.png`];
    p = (json === undefined || png === undefined ? Promise.reject(new Error(`no sheet for theme ${id}`)) : Promise.all([json(), png(), import("./sheet")]).then(([j, url, m]) => m.loadThemeSheet(id, j, url))).catch(
      (e: unknown) => {
        loading.delete(id);
        throw e;
      },
    );
    loading.set(id, p);
  }
  return p;
}
