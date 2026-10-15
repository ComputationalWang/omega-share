// A holiday theme's art (OME-1186, ADR 0052). room-view.ts imports this module only while a theme is active, and each
// theme's sheet is its own chunk below it, so the landing page and initial JS never carry any of it.
import type { Texture } from "pixi.js";
import type { Sheet } from "../atlas-sheet";
import type { DecorPiece } from "./decor";
import type { EffectFrame, EffectMotion } from "./effect";
import type { ThemeId } from "./periods";

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

export interface ThemeAtlas extends Sheet {
  readonly id: ThemeId;
  readonly decor: readonly DecorPiece[];
  readonly effect: ThemeEffect;
  /** The hat drawn over an avatar frame (`breathe/juno/idle/se/0`, …) at the same floor point, or none for that frame. */
  hat(avatarFrame: string): Texture | undefined;
}

const FULL = { x: 0, y: 0, w: 960, h: 600 };

/** How each theme's particles drift (plan OME-1140: bats cross the back wall, the rest fall, rise or blow). */
export const MOTIONS: Readonly<Record<ThemeId, EffectMotion>> = {
  halloween: { area: { x: 120, y: 40, w: 720, h: 200 }, vx: [30, 55], vy: [-6, 6], flipX: true },
  sinterklaas: { area: FULL, vx: [-6, 6], vy: [20, 35], flipX: false },
  christmas: { area: FULL, vx: [-10, 10], vy: [22, 45], flipX: false },
  valentine: { area: FULL, vx: [-8, 8], vy: [-22, -12], flipX: false },
  easter: { area: FULL, vx: [14, 28], vy: [8, 18], flipX: true },
};

/** Load once per theme; a failed load is forgotten so a later room can retry. */
const loading = new Map<ThemeId, Promise<ThemeAtlas>>();

export function loadTheme(id: ThemeId): Promise<ThemeAtlas> {
  let p = loading.get(id);
  if (p === undefined) {
    // shortcut: four themes draw placeholder rects until their art lands (plan OME-1140 issue E); each then gets its own module like halloween.ts.
    p = (id === "halloween" ? import("./halloween").then((m) => m.loadHalloween()) : import("./placeholder").then((m) => m.loadPlaceholder(id))).catch((e: unknown) => {
      loading.delete(id);
      throw e;
    });
    loading.set(id, p);
  }
  return p;
}
