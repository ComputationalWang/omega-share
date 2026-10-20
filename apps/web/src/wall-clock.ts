// OME-1557: the wall clock shows the viewer's local time. Stub (red).

/** Hour 0–11 (on the hour mark), minute 0–59. */
export interface HandSteps {
  readonly hour: number;
  readonly minute: number;
}

export function handSteps(_d: Date): HandSteps {
  return { hour: -1, minute: -1 };
}

/** One stage px of the face, relative to the piece's anchor point. */
export interface FacePixel {
  readonly x: number;
  readonly y: number;
  readonly color: number;
}

export function clockFace(_facing: "se" | "sw", _s: HandSteps): FacePixel[] {
  return [];
}

export interface MinuteTicksOptions {
  readonly now: () => Date;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
  readonly document: { readonly visibilityState: string; addEventListener(type: "visibilitychange", fn: () => void): void; removeEventListener(type: "visibilitychange", fn: () => void): void };
  readonly onTick: (now: Date) => void;
}

export function minuteTicks(_o: MinuteTicksOptions): () => void {
  return () => undefined;
}
