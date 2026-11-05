// A render re-places every still name tag and hit pad (stage.ts `restack`), mostly where each already is (OME-2219).
// Every inline style write parses a new CSS value into Blink's heap and restyles the tag, and with 25 walkers a render
// runs on nearly every frame (Pixel 7 /conga row). Only a changed anchor is written; tag-stack's `wearPlace` does the
// same for the stack move.

const written = new WeakMap<HTMLElement, { x: number; y: number }>();

/** Put `e`'s anchor (`translate`, so room.css's centring and readable-zoom scale stay in `transform` / `scale`) at (x, y), stage px. */
export function placeAt(e: HTMLElement, x: number, y: number): void {
  const w = written.get(e);
  if (w?.x === x && w.y === y) return;
  e.style.translate = `${String(x)}px ${String(y)}px`;
  if (w === undefined) written.set(e, { x, y });
  else {
    w.x = x;
    w.y = y;
  }
}
