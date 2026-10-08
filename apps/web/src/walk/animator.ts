// Drives avatar motion without a ticker (OME-185 keeps the room render-on-demand). While someone walks, one timer per
// 150 ms step (walkers share the step clock, walks.ts); at rest, one timer to the next breathe change on a 400 ms clock.
// Each timer then asks for one rAF, so a hidden tab never renders.
import type { MemberId } from "@omega/shared";
import { DIRS, cycleFrame, type MotionFrames } from "./motion";
import { WALK_FRAME_MS, emptyPose, type Pose, type Walks } from "./walks";

/** Breathing redraws wait for this shared clock, so a room at rest renders at most 2.5 times a second however full. */
export const BREATHE_TICK_MS = 400;

export interface AnimatedAvatar {
  readonly id: MemberId;
  readonly avatar: number;
}

export interface AnimatorOptions {
  readonly walks: Walks;
  readonly now: () => number;
  readonly raf: (fn: () => void) => void;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
  readonly reducedMotion: () => boolean;
  /** Put one avatar at `pose`; `frame` is its motion frame key, null until the atlas is in. */
  readonly draw: (id: MemberId, avatar: number, pose: Pose, frame: string | null) => void;
  readonly render: () => void;
}

export interface Animator {
  /** Who is in the room, after `walks.place`: draws them now (the caller renders) and keeps animating as needed. */
  set(avatars: readonly AnimatedAvatar[]): void;
  /** The motion atlas arrived: redraw everyone with it on the next frame. */
  setFrames(frames: MotionFrames): void;
  /** The room is gone: drop any queued frame or timer and never draw again. */
  dispose(): void;
}

export function createAnimator(o: AnimatorOptions): Animator {
  let list: readonly AnimatedAvatar[] = [];
  let frames: MotionFrames | null = null;
  let framePending = false;
  let timer: unknown = null;
  let disposed = false;
  const pose = emptyPose();

  function frameKey(avatar: number, p: Pose, still: boolean): string | null {
    if (frames === null) return null;
    const d = DIRS.indexOf(p.dir);
    if (p.walking) return frames.walk[avatar]?.[d]?.[p.step] ?? null;
    const rest = frames.rest[avatar];
    const cycle = (p.sitting ? rest?.sit : rest?.idle)?.[d];
    if (cycle === undefined) return null;
    return cycle.frames[still ? 0 : cycleFrame(cycle.ms, p.restMs).index] ?? null;
  }

  /** Draws everyone at `now`; returns the ms until the next breathe change (Infinity if none). */
  function drawAll(now: number): number {
    const still = o.reducedMotion();
    let next = Infinity;
    for (const a of list) {
      if (!o.walks.sample(a.id, now, pose)) continue;
      o.draw(a.id, a.avatar, pose, frameKey(a.avatar, pose, still));
      if (pose.walking || still || frames === null) continue;
      const cycle = (pose.sitting ? frames.rest[a.avatar]?.sit : frames.rest[a.avatar]?.idle)?.[DIRS.indexOf(pose.dir)];
      if (cycle !== undefined) next = Math.min(next, cycleFrame(cycle.ms, pose.restMs).nextIn);
    }
    return next;
  }

  const tick = (): void => {
    framePending = false;
    if (disposed) return;
    const now = o.now();
    const next = drawAll(now);
    o.render();
    schedule(now, next);
  };

  function requestFrame(): void {
    if (framePending || disposed) return;
    framePending = true;
    o.raf(tick);
  }

  const onTimer = (): void => {
    timer = null;
    requestFrame();
  };

  function schedule(now: number, nextBreath: number): void {
    if (timer !== null) {
      o.clearTimer(timer);
      timer = null;
    }
    if (disposed) return;
    if (o.walks.walking(now)) {
      const at = (Math.floor(now / WALK_FRAME_MS) + 1) * WALK_FRAME_MS;
      timer = o.setTimer(onTimer, at - now);
    } else if (nextBreath !== Infinity) {
      const at = Math.ceil((now + nextBreath) / BREATHE_TICK_MS) * BREATHE_TICK_MS;
      timer = o.setTimer(onTimer, at - now);
    }
  }

  return {
    set(avatars) {
      if (disposed) return;
      list = avatars;
      const now = o.now();
      schedule(now, drawAll(now));
    },
    setFrames(f) {
      frames = f;
      requestFrame();
    },
    dispose() {
      disposed = true;
      if (timer !== null) o.clearTimer(timer);
      timer = null;
    },
  };
}
