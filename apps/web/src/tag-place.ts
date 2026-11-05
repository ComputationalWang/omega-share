// A render re-places every still name tag and hit pad (stage.ts `restack`), mostly where each already is (OME-2219).
// Every inline style write parses a new CSS value into Blink's heap and restyles the tag, and with 25 walkers a render
// runs on nearly every frame (Pixel 7 /conga row). Only what changed is written.

/** What was last written to an element: its anchor (`translate`) and its stack move (margins), stage px. */
interface Written {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

const written = new WeakMap<HTMLElement, Written>();

/**
 * Put `e`'s anchor at (x, y) and move it by (dx, dy), writing only the styles that change. The anchor is `translate`, so
 * room.css's centring and readable-zoom scale stay in `transform` / `scale`.
 */
export function placeAt(e: HTMLElement, x: number, y: number, dx: number, dy: number): void {
  const w = written.get(e);
  if (w?.x !== x || w.y !== y) e.style.translate = `${String(x)}px ${String(y)}px`;
  if (w?.dx !== dx) e.style.marginLeft = `${String(dx)}px`;
  if (w?.dy !== dy) e.style.marginTop = `${String(dy)}px`;
  if (w === undefined) written.set(e, { x, y, dx, dy });
  else {
    w.x = x;
    w.y = y;
    w.dx = dx;
    w.dy = dy;
  }
}
