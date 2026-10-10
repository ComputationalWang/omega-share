// Drives avatar motion without a ticker (OME-185 keeps the room render-on-demand). While someone walks, one timer per
// 150 ms step (walkers share the step clock, walks.ts); at rest, one timer to the next breathe change on a 400 ms clock.
// Each timer then asks for one rAF, so a hidden tab never renders. An emote (OME-415) plays once on the same loop, its
// timers on the one-shot's own frame times: a wave swaps the avatar's frames, a sticker is drawn above the avatar.
import type { EmoteKind, MemberId } from "@omega/shared";
import { DIRS, cycleFrame, oneShotFrame, type MotionFrames, type StickerKind } from "./motion";
import { WALK_FRAME_MS, emptyPose, type Pose, type Walks } from "./walks";

/** Breathing redraws wait for this shared clock, so a room at rest renders at most 2.5 times a second however full. */
export const BREATHE_TICK_MS = 400;

/** How far above the floor point a sticker's bottom sits: just over the head, standing or seated. */
export const EMOTE_LIFT = { idle: 60, sit: 50 } as const;

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
  /** Put `id`'s emote sticker (a motion frame key) with its bottom centre at (x, y), or hide it (null). Called on every draw. */
  readonly drawEmote: (id: MemberId, frame: string | null, x: number, y: number) => void;
  readonly render: () => void;
}

export interface Animator {
  /** Who is in the room, after `walks.place`: draws them now (the caller renders) and keeps animating as needed. */
  set(avatars: readonly AnimatedAvatar[]): void;
  /** The motion atlas arrived: redraw everyone with it on the next frame. */
  setFrames(frames: MotionFrames): void;
  /** `id` emoted: play it once from now. Nothing under prefers-reduced-motion (room.ts shows a static badge). */
  emote(id: MemberId, kind: EmoteKind): void;
  /** Full screen hides the room (OME-597): paused, nothing is drawn or scheduled; on resume one frame draws everyone now. */
  pause(paused: boolean): void;
  /** The room is gone: drop any queued frame or timer and never draw again. */
  dispose(): void;
}

export function createAnimator(o: AnimatorOptions): Animator {
  let list: readonly AnimatedAvatar[] = [];
  let frames: MotionFrames | null = null;
  let framePending = false;
  let timer: unknown = null;
  let disposed = false;
  let paused = false;
  const pose = emptyPose();
  /** Per member: when their wave started (NaN: none), and the sticker playing (null: none) since when. */
  const plays = new Map<MemberId, { wave: number; sticker: StickerKind | null; stickerAt: number }>();
  /** Set by drawAll: ms until the next emote frame change (Infinity if none). */
  let nextEmote = Infinity;

  function frameKey(avatar: number, p: Pose, still: boolean): string | null {
    if (frames === null) return null;
    const d = DIRS.indexOf(p.dir);
    if (p.walking) return frames.walk8[avatar]?.[d]?.[p.step] ?? null;
    const rest = frames.rest[avatar];
    const cycle = (p.sitting ? rest?.sit : rest?.idle)?.[d];
    if (cycle === undefined) return null;
    return cycle.frames[still ? 0 : cycleFrame(cycle.ms, p.restMs).index] ?? null;
  }

  /** Draws everyone at `now`; returns the ms until the next breathe change (Infinity if none), and sets `nextEmote`. */
  function drawAll(now: number): number {
    const still = o.reducedMotion();
    let next = Infinity;
    nextEmote = Infinity;
    for (const a of list) {
      if (!o.walks.sample(a.id, now, pose)) continue;
      let frame = frameKey(a.avatar, pose, still);
      let sticker: string | null = null;
      const play = plays.get(a.id);
      if (play !== undefined && frames !== null && !still) {
        if (!Number.isNaN(play.wave) && !pose.walking) {
          const waves = frames.wave[a.avatar];
          const cycle = (pose.sitting ? waves?.sit : waves?.idle)?.[DIRS.indexOf(pose.dir)];
          const f = cycle === undefined ? null : oneShotFrame(cycle.ms, now - play.wave);
          if (f === null || (f.index < 0 && f.nextIn === Infinity)) play.wave = NaN;
          else {
            if (f.index >= 0) frame = cycle?.frames[f.index] ?? frame;
            nextEmote = Math.min(nextEmote, f.nextIn);
          }
        }
        if (play.sticker !== null) {
          const cycle = frames.emote[play.sticker];
          const f = oneShotFrame(cycle.ms, now - play.stickerAt);
          if (f.index < 0 && f.nextIn === Infinity) play.sticker = null;
          else {
            if (f.index >= 0) sticker = cycle.frames[f.index] ?? null;
            nextEmote = Math.min(nextEmote, f.nextIn);
          }
        }
      }
      o.draw(a.id, a.avatar, pose, frame);
      o.drawEmote(a.id, sticker, pose.x, pose.y - (pose.sitting ? EMOTE_LIFT.sit : EMOTE_LIFT.idle));
      if (pose.walking || still || frames === null) continue;
      const cycle = (pose.sitting ? frames.rest[a.avatar]?.sit : frames.rest[a.avatar]?.idle)?.[DIRS.indexOf(pose.dir)];
      if (cycle !== undefined) next = Math.min(next, cycleFrame(cycle.ms, pose.restMs).nextIn);
    }
    return next;
  }

  const tick = (): void => {
    framePending = false;
    if (disposed || paused) return;
    const now = o.now();
    const next = drawAll(now);
    o.render();
    schedule(now, next);
  };

  function requestFrame(): void {
    if (framePending || disposed || paused) return;
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
    if (disposed || paused) return;
    let wait = nextEmote;
    if (o.walks.walking(now)) {
      const at = (Math.floor(now / WALK_FRAME_MS) + 1) * WALK_FRAME_MS;
      wait = Math.min(wait, at - now);
    } else if (nextBreath !== Infinity) {
      const at = Math.ceil((now + nextBreath) / BREATHE_TICK_MS) * BREATHE_TICK_MS;
      wait = Math.min(wait, at - now);
    }
    if (wait !== Infinity) timer = o.setTimer(onTimer, wait);
  }

  return {
    set(avatars) {
      if (disposed) return;
      list = avatars;
      for (const id of plays.keys()) if (!avatars.some((a) => a.id === id)) plays.delete(id);
      if (paused) return;
      const now = o.now();
      schedule(now, drawAll(now));
    },
    setFrames(f) {
      frames = f;
      requestFrame();
    },
    emote(id, kind) {
      if (disposed || paused || o.reducedMotion() || !list.some((a) => a.id === id)) return;
      let play = plays.get(id);
      if (play === undefined) {
        play = { wave: NaN, sticker: null, stickerAt: 0 };
        plays.set(id, play);
      }
      const now = o.now();
      if (kind === "wave") play.wave = now;
      else {
        play.sticker = kind;
        play.stickerAt = now;
      }
      requestFrame();
    },
    pause(next) {
      if (next === paused || disposed) return;
      paused = next;
      if (paused) {
        if (timer !== null) o.clearTimer(timer);
        timer = null;
      } else requestFrame();
    },
    dispose() {
      disposed = true;
      if (timer !== null) o.clearTimer(timer);
      timer = null;
    },
  };
}
