// A sprite's drawn top (OME-2252, judge round 8): a sitter's name tag sits on the hair or hat it shows, not a nominal box.
// Read once per texture from its image, on a scratch canvas: a frame change, never per frame.

import type { Sprite, Texture } from "pixi.js";

/** Each texture's transparent rows over its first opaque one; -1 where its image can't be read (a GPU-only texture). */
const tops = new WeakMap<Texture, number>();
let scratch: OffscreenCanvasRenderingContext2D | null | undefined;

function topRow(t: Texture): number {
  const known = tops.get(t);
  if (known !== undefined) return known;
  const src: unknown = t.source.resource;
  const readable = (typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap) || (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement) || (typeof HTMLCanvasElement !== "undefined" && src instanceof HTMLCanvasElement) || (typeof OffscreenCanvas !== "undefined" && src instanceof OffscreenCanvas);
  scratch ??= typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(64, 128).getContext("2d", { willReadFrequently: true });
  let top = -1;
  const { x, y, width: w, height: h } = t.frame;
  if (readable && scratch !== null && w > 0 && h > 0) {
    const g = scratch;
    if (g.canvas.width < w || g.canvas.height < h) {
      g.canvas.width = Math.max(g.canvas.width, w);
      g.canvas.height = Math.max(g.canvas.height, h);
    }
    g.clearRect(0, 0, w, h);
    g.drawImage(src, x, y, w, h, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    // A fully transparent frame has nothing on top: its top is its foot.
    top = h;
    for (let i = 3; i < px.length; i += 4)
      if ((px[i] ?? 0) !== 0) {
        top = Math.floor((i - 3) / 4 / w);
        break;
      }
  }
  tops.set(t, top);
  return top;
}

/** How far `s`'s highest opaque pixel is over its anchor (px), or undefined where its image can't be read. */
export function inkLift(s: Sprite): number | undefined {
  const top = topRow(s.texture);
  return top < 0 ? undefined : s.anchor.y * s.texture.frame.height - top;
}
