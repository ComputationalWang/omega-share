// OME-1557: the wall clock shows the viewer's local time. Its hands are re-cast over the baked face (assets/src/furniture.ts
// `wallClock`) with the art's own rules and palette, so the face at the art's own time is pixel-identical to the sprite.

/** Hour 0–11 (on the hour mark, 12 steps), minute 0–59 (60 steps: the raster already snaps them to whole pixels). */
export interface HandSteps {
  readonly hour: number;
  readonly minute: number;
}

export const handSteps = (d: Date): HandSteps => ({ hour: d.getHours() % 12, minute: d.getMinutes() });

/** One stage px of the face (its top-left corner), relative to the piece's anchor point. */
export interface FacePixel {
  readonly x: number;
  readonly y: number;
  readonly color: number;
}

const CREAM = 0xfff7ea;
const HUB = 0xf7d36b;
const HAND = 0x2b1d2f;
/** The face plane's centre from the anchor: the art's (0, 6.4, 94) local point through iso.ts `project`. */
const CENTRE: Readonly<Record<"se" | "sw", readonly [number, number]>> = { se: [-12.8, -100.4], sw: [12.8, -100.4] };

/** The cream disc inside the ticks, with the hub and both hands; the ticks, rim and rays stay the sprite's. */
export function clockFace(facing: "se" | "sw", s: HandSteps): FacePixel[] {
  const [cx, cy] = CENTRE[facing];
  const hour = (s.hour * Math.PI) / 6;
  const minute = (s.minute * Math.PI) / 30;
  const out: FacePixel[] = [];
  for (let y = Math.floor(cy) - 6; y <= Math.floor(cy) + 6; y++) {
    for (let x = Math.floor(cx) - 9; x <= Math.floor(cx) + 9; x++) {
      // A local unit along the wall is 2 px across and 1 px down the slant; up is 1 px up. `a` is right as the viewer sees it.
      const a = (x + 0.5 - cx) / 2;
      const b = (facing === "se" ? -a : a) - (y + 0.5 - cy);
      const r = Math.hypot(a, b);
      if (r > 3.2) continue;
      const on = (t: number, l: number): boolean => r < l && Math.abs(a * Math.cos(t) - b * Math.sin(t)) < 0.55 && a * Math.sin(t) + b * Math.cos(t) > 0;
      out.push({ x, y, color: r < 0.5 ? HUB : on(hour, 2.2) || on(minute, 3) ? HAND : CREAM });
    }
  }
  return out;
}

export interface MinuteTicksOptions {
  readonly now: () => Date;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
  readonly document: { readonly visibilityState: string; addEventListener(type: "visibilitychange", fn: () => void): void; removeEventListener(type: "visibilitychange", fn: () => void): void };
  readonly onTick: (now: Date) => void;
}

/** `onTick` now and on every minute boundary while the tab is visible; hidden, no timer at all, and a tick on return. Returns stop. */
export function minuteTicks(o: MinuteTicksOptions): () => void {
  let timer: unknown;
  const tick = (): void => {
    const d = o.now();
    o.onTick(d);
    timer = o.setTimer(tick, 60_000 - d.getSeconds() * 1000 - d.getMilliseconds());
  };
  const onVisibility = (): void => {
    o.clearTimer(timer);
    timer = undefined;
    if (o.document.visibilityState === "visible") tick();
  };
  o.document.addEventListener("visibilitychange", onVisibility);
  if (o.document.visibilityState === "visible") tick();
  return () => {
    o.clearTimer(timer);
    o.document.removeEventListener("visibilitychange", onVisibility);
  };
}
