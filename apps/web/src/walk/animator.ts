// Drives avatar motion without a ticker (OME-185 keeps the room render-on-demand). While someone walks: in Basic, one
// timer per 150 ms step (walkers share the step clock, walks.ts); in Smooth (ADR 0037), the next rAF from each frame
// until everyone has arrived. At rest, one timer to the next breathe change on a 400 ms clock. Each timer then asks
// for one rAF, so a hidden tab never renders. An emote (OME-415) plays once on the same loop, its
// timers on the one-shot's own frame times: a gesture (wave, cheer, yawn) swaps the avatar's frames, a sticker is drawn
// above the avatar. A dance (OME-1378) plays the avatar's own walk cycle in place for DANCE_MS, on the walkers' clock.
// Furniture in use (OME-1407) loops on the same clock: one timer per frame change, none once nothing is in use.
import type { MemberId } from "@omega/shared";
import { DIRS, cycleFrame, oneShotFrame, type AvatarEmote, type GestureKind, type MotionFrames, type StickerKind } from "./motion";
import { PAIR_MS, THRUST_FRAME_MS, THRUST_SEQUENCE, frontIndex, pairKeys } from "./pair";
import { SMOOTH_FRAMES, SMOOTH_FRAME_MS, WALK_FRAMES, WALK_FRAME_MS, emptyPose, type Pose, type Walks } from "./walks";

/** Breathing redraws wait for this shared clock, so a room at rest renders at most 2.5 times a second however full. */
export const BREATHE_TICK_MS = 400;

/** How far above the floor point a sticker's bottom sits: just over the head, standing or seated. */
export const EMOTE_LIFT = { idle: 60, sit: 50 } as const;

/** How long a dance lasts, unless the dancer walks, sits or leaves first. */
export const DANCE_MS = 8000;

/** A dancer turns se → sw → nw → ne (DIRS indices), one facing per walk cycle: 4 Basic steps, 8 Smooth ones, so tiers agree. */
const SPIN: readonly number[] = [0, 1, 3, 2];

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
  /** The Smooth tier (walk/tier.ts): while anyone walks, draw every frame. Read each frame. */
  readonly smooth: () => boolean;
  /** After each render: when its frame started (`now()`), and whether it was a Smooth frame drawing a walk (the tier probe). */
  readonly rendered?: (start: number, walking: boolean) => void;
  /** Put one avatar at `pose`; `frame` is its motion frame key, null until the atlas is in. */
  readonly draw: (id: MemberId, avatar: number, pose: Pose, frame: string | null) => void;
  /** Put `id`'s emote sticker (a motion frame key) with its bottom centre at (x, y), or hide it (null). Called on every draw. */
  readonly drawEmote: (id: MemberId, frame: string | null, x: number, y: number) => void;
  /** Furniture loop `i` (setLoops) shows `frame`, or its still frame (-1). */
  readonly drawLoop: (i: number, frame: number) => void;
  /** Draws the room's walking props (the cat, OME-1520) at `now`; true while one walks, so frames keep coming. */
  readonly drawProps?: (now: number) => boolean;
  readonly render: () => void;
}

/** A furniture "in use" loop (OME-1407): how many frames, and the frame time on Smooth. */
export interface FurnitureLoop {
  readonly frames: number;
  readonly ms: number;
}

export interface Animator {
  /** Who is in the room, after `walks.place`: draws them now (the caller renders) and keeps animating as needed. */
  set(avatars: readonly AnimatedAvatar[]): void;
  /** The furniture loops that run now (OME-1407), drawn through `drawLoop` by index. */
  setLoops(loops: readonly FurnitureLoop[]): void;
  /** The motion atlas arrived: redraw everyone with it on the next frame. */
  setFrames(frames: MotionFrames): void;
  /** `id` emoted: play it once from now. Nothing under prefers-reduced-motion (room.ts shows a static badge). */
  emote(id: MemberId, kind: AvatarEmote): void;
  /** The dank-dungeon pair (OME-1672): `thruster` and `bender` play their poses for PAIR_MS, then go back to idle. Nothing under reduced motion. */
  pair(thruster: MemberId, bender: MemberId): void;
  /** A prop started walking (OME-1520): draw on the next frame and keep going while it walks. */
  wake(): void;
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
  /** Per member: the gesture playing (null: none) since when, the sticker playing (null: none) since when, and the dance's start (null: none). */
  const plays = new Map<MemberId, { gesture: GestureKind | null; gestureAt: number; sticker: StickerKind | null; stickerAt: number; danceAt: number | null; pair: { readonly bender: boolean; readonly other: MemberId; readonly at: number } | null }>();
  /** The partner's sampled pose, and the pose a thruster is drawn at (the bender's spot). Scratch, never allocated per frame. */
  const partner = emptyPose();
  /** Set by drawAll: ms until the next emote frame change (Infinity if none). */
  let nextEmote = Infinity;
  /** Furniture "in use" loops running now (OME-1407). */
  let loops: readonly FurnitureLoop[] = [];
  /** Set by drawAll: ms until the next loop frame change (Infinity if none). */
  let nextLoop = Infinity;
  /** Set by drawAll: someone danced in it, so the next frame is on the walkers' clock. */
  let dancing = false;
  /** Set by drawAll: a prop (the cat, OME-1520) walked in it; same clock. */
  let propWalking = false;

  function playOf(id: MemberId) {
    let play = plays.get(id);
    if (play === undefined) {
      play = { gesture: null, gestureAt: 0, sticker: null, stickerAt: 0, danceAt: null, pair: null };
      plays.set(id, play);
    }
    return play;
  }

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
    dancing = false;
    nextLoop = Infinity;
    propWalking = o.drawProps?.(now) ?? false;
    if (loops.length > 0) {
      // Basic steps every loop on the walkers' 150 ms clock; Smooth gives each its own frame time. Still: frame -1.
      const smooth = o.smooth();
      let i = 0;
      for (const l of loops) {
        // One frame (a door's open one) is a state, not motion: drawn under reduced motion too, and never wakes the clock.
        if (l.frames === 1) {
          o.drawLoop(i++, 0);
          continue;
        }
        const ms = smooth ? l.ms : WALK_FRAME_MS;
        o.drawLoop(i++, still ? -1 : Math.floor(now / ms) % l.frames);
        if (!still) nextLoop = Math.min(nextLoop, ms - (now % ms));
      }
    }
    for (const a of list) {
      if (!o.walks.sample(a.id, now, pose)) continue;
      let frame = frameKey(a.avatar, pose, still);
      let sticker: string | null = null;
      let drawn = pose;
      const play = plays.get(a.id);
      if (play !== undefined && frames !== null && !still) {
        if (play.danceAt !== null) {
          const t = now - play.danceAt;
          if (pose.walking || pose.sitting || t >= DANCE_MS) play.danceAt = null;
          else {
            const smooth = o.smooth();
            const ms = smooth ? SMOOTH_FRAME_MS : WALK_FRAME_MS;
            const per = smooth ? SMOOTH_FRAMES : WALK_FRAMES;
            // Steps on the shared clock, counted from the one the dance started in; Basic draws walk8's even frames, as a walk does.
            const k = Math.floor(now / ms) - Math.floor(play.danceAt / ms);
            const turn = (SPIN.indexOf(DIRS.indexOf(pose.dir)) + Math.floor(k / per)) % SPIN.length;
            frame = frames.walk8[a.avatar]?.[SPIN[turn] ?? 0]?.[(k % per) * (smooth ? 1 : 2)] ?? frame;
            dancing = true;
            nextEmote = Math.min(nextEmote, DANCE_MS - t);
          }
        }
        const pair = play.pair;
        if (pair !== null) {
          const t = now - pair.at;
          // Either of them walking, sitting or leaving ends it.
          if (pose.walking || pose.sitting || t >= PAIR_MS || !o.walks.sample(pair.other, now, partner) || partner.walking || partner.sitting) play.pair = null;
          else {
            const bender = pair.bender ? pose : partner;
            const keys = pairKeys(a.avatar, frontIndex(bender.dir));
            if (keys !== undefined) {
              if (pair.bender) frame = keys.bend;
              else {
                frame = keys.thrust[THRUST_SEQUENCE[Math.floor(t / THRUST_FRAME_MS) % THRUST_SEQUENCE.length] ?? 0] ?? frame;
                // Anchored on the bender's floor point, drawn there, just behind them.
                partner.z -= 0.5;
                drawn = partner;
              }
            }
            nextEmote = Math.min(nextEmote, pair.bender ? PAIR_MS - t : Math.min(PAIR_MS - t, THRUST_FRAME_MS - (t % THRUST_FRAME_MS)));
          }
        }
        if (play.gesture !== null && !pose.walking) {
          const cycles = frames[play.gesture][a.avatar];
          const cycle = (pose.sitting ? cycles?.sit : cycles?.idle)?.[DIRS.indexOf(pose.dir)];
          const f = cycle === undefined ? null : oneShotFrame(cycle.ms, now - play.gestureAt);
          if (f === null || (f.index < 0 && f.nextIn === Infinity)) play.gesture = null;
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
      o.draw(a.id, a.avatar, drawn, frame);
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
    const walking = o.walks.walking(now) || dancing || propWalking;
    o.rendered?.(now, walking && o.smooth());
    schedule(now, next, walking);
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

  /** `walking` is `walks.walking(now)` or someone dancing, asked once per frame by the caller (each call walks a Map iterator). */
  function schedule(now: number, nextBreath: number, walking: boolean): void {
    if (timer !== null) {
      o.clearTimer(timer);
      timer = null;
    }
    if (disposed || paused) return;
    let wait = Math.min(nextEmote, nextLoop);
    if (walking && o.smooth()) {
      requestFrame();
      return;
    }
    if (walking) {
      // A jog (OME-1464) steps on the half ticks of the same clock.
      const ms = o.walks.jogging(now) ? WALK_FRAME_MS / 2 : WALK_FRAME_MS;
      const at = (Math.floor(now / ms) + 1) * ms;
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
      const next = drawAll(now);
      schedule(now, next, o.walks.walking(now) || dancing || propWalking);
    },
    setLoops(next) {
      loops = next;
      requestFrame();
    },
    setFrames(f) {
      frames = f;
      requestFrame();
    },
    emote(id, kind) {
      if (disposed || paused || o.reducedMotion() || !list.some((a) => a.id === id)) return;
      const play = playOf(id);
      const now = o.now();
      // One avatar plays one of its own animations at a time: a gesture stops a dance and a dance a gesture.
      if (kind === "dance") {
        play.danceAt = now;
        play.gesture = null;
      } else if (kind === "wave" || kind === "cheer" || kind === "yawn" || kind === "reach") {
        play.gesture = kind;
        play.gestureAt = now;
        play.danceAt = null;
      } else {
        play.sticker = kind;
        play.stickerAt = now;
      }
      requestFrame();
    },
    pair(thruster, bender) {
      if (disposed || paused || o.reducedMotion() || !list.some((a) => a.id === thruster) || !list.some((a) => a.id === bender)) return;
      const at = o.now();
      for (const [who, other, isBender] of [[thruster, bender, false], [bender, thruster, true]] as const) {
        const play = playOf(who);
        play.pair = { bender: isBender, other, at };
        play.danceAt = null;
        play.gesture = null;
      }
      requestFrame();
    },
    wake: requestFrame,
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
