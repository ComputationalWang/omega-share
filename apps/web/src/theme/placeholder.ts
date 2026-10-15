// Placeholder art for the themes whose sheets haven't landed yet (OME-1186; real art: plan OME-1140 issue E): coloured
// rects on one small canvas, so the engine, its e2e and the perf rows run with the real sprite counts. Its own chunk.
import { CanvasSource, Rectangle, Texture } from "pixi.js";
import { MOTIONS, type ThemeAtlas } from "./atlas";
import type { ThemeId } from "./periods";

/** Decor, hat and particle colours, and the plan's sprite cap, per theme. */
const LOOK: Readonly<Record<Exclude<ThemeId, "halloween">, { decor: string; hat: string; particle: string; max: number }>> = {
  sinterklaas: { decor: "#c8102e", hat: "#c8102e", particle: "#8a5a2b", max: 20 },
  christmas: { decor: "#2e7d32", hat: "#d62828", particle: "#f4f1ea", max: 40 },
  valentine: { decor: "#e75480", hat: "#e75480", particle: "#ff8fab", max: 12 },
  easter: { decor: "#9bc53d", hat: "#f4f1ea", particle: "#ffc8dd", max: 20 },
};

// Sheet: decor 24×16 at (0,0), hat 18×8 at (0,16), particle 6×6 at (24,0).
const DECOR = new Rectangle(0, 0, 24, 16);
const HAT = new Rectangle(0, 16, 18, 8);
const PARTICLE = new Rectangle(24, 0, 6, 6);

export function loadPlaceholder(id: Exclude<ThemeId, "halloween">): Promise<ThemeAtlas> {
  const look = LOOK[id];
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 24;
  const g = canvas.getContext("2d");
  if (g !== null) {
    for (const [r, fill] of [
      [DECOR, look.decor],
      [HAT, look.hat],
      [PARTICLE, look.particle],
    ] as const) {
      g.fillStyle = fill;
      g.fillRect(r.x, r.y, r.width, r.height);
    }
  }
  const source = new CanvasSource({ resource: canvas, scaleMode: "nearest" });
  // Decor hangs over its wall frame's floor point, about head height on the wall; a hat sits on the head (sitting is lower).
  const decor = new Texture({ source, frame: DECOR, defaultAnchor: { x: 0.5, y: 7 } });
  const particle = new Texture({ source, frame: PARTICLE, defaultAnchor: { x: 0.5, y: 0.5 } });
  const standingHat = new Texture({ source, frame: HAT, defaultAnchor: { x: 0.5, y: 7 } });
  const sittingHat = new Texture({ source, frame: HAT, defaultAnchor: { x: 0.5, y: 6 } });
  const keys: Readonly<Record<string, Texture>> = { [`${id}/decor`]: decor, [`${id}/particle`]: particle };
  return Promise.resolve({
    id,
    texture: (key) => keys[key],
    decor: [
      { key: `${id}/decor`, on: "wall/l/window0" },
      { key: `${id}/decor`, on: "wall/r/poster0" },
    ],
    effect: { frames: [`${id}/particle`], ms: 1000, max: look.max, motion: MOTIONS[id] },
    hat: (frame) => (frame.includes("/sit/") ? sittingHat : standingHat),
  });
}
