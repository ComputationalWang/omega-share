// Set (d) motion meta (ADR 0010), parsed at load: which frames a walk or a breathe shows, per avatar and direction.
// Pure, no Pixi; motion-atlas.ts turns the keys into textures once.
import * as v from "valibot";
import { AVATAR_COUNT, type EmoteKind } from "@omega/shared";
import { WALK_FRAMES, WALK_FRAME_MS, type Dir } from "./walks";

/** Index order of every per-direction table. */
export const DIRS: readonly Dir[] = ["se", "sw", "ne", "nw"];

const FrameSchema = v.object({ frame: v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() }), anchor: v.object({ x: v.number(), y: v.number() }) });
const FramesSchema = v.record(v.string(), FrameSchema);
const AnimSchema = v.object({ frames: v.pipe(v.array(v.string()), v.minLength(1)), ms: v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), loop: v.boolean() });

export const MotionSheetSchema = v.object({
  frames: FramesSchema,
  meta: v.object({
    omega: v.object({
      walk: v.object({ frameMs: v.literal(WALK_FRAME_MS), tilesPerCycle: v.literal(1) }),
      anims: v.record(v.string(), AnimSchema),
    }),
  }),
});

export const AvatarSheetSchema = v.object({
  frames: FramesSchema,
  meta: v.object({ omega: v.object({ avatars: v.pipe(v.array(v.object({ id: v.string() })), v.length(AVATAR_COUNT)) }) }),
});

export interface Cycle {
  readonly frames: readonly string[];
  readonly ms: readonly number[];
}

export type FrameRects = v.InferOutput<typeof FramesSchema>;

/** The emotes drawn as a sticker over the avatar (`emote/<kind>`); `wave` is the avatar's own animation. */
export type StickerKind = Exclude<EmoteKind, "wave">;

/** Per pose, per direction (DIRS order). */
export interface PoseCycles {
  readonly idle: readonly Cycle[];
  readonly sit: readonly Cycle[];
}

export interface MotionFrames {
  /** Each sheet's frame rects and anchors, as parsed: motion.png's, then avatars.png's. */
  readonly sheets: { readonly motion: FrameRects; readonly avatars: FrameRects };
  /** walk[avatar][dir][step]: frame keys. */
  readonly walk: readonly (readonly (readonly string[])[])[];
  /** rest[avatar].idle|sit[dir]: the breathe cycle. */
  readonly rest: readonly PoseCycles[];
  /** wave[avatar].idle|sit[dir]: the one-shot wave (OME-415). */
  readonly wave: readonly PoseCycles[];
  /** emote[kind]: the one-shot sticker. */
  readonly emote: Readonly<Record<StickerKind, Cycle>>;
}

/** Throws unless both sheets parse and every walk and breathe frame resolves in one of them. */
export function parseMotion(motionJson: unknown, avatarsJson: unknown): MotionFrames {
  const motion = v.parse(MotionSheetSchema, motionJson);
  const sheet = v.parse(AvatarSheetSchema, avatarsJson);
  const has = (k: string): boolean => k in motion.frames || k in sheet.frames;
  const anim = (name: string, frames: number): v.InferOutput<typeof AnimSchema> => {
    const a = motion.meta.omega.anims[name];
    if (a?.loop !== true || a.frames.length !== frames || a.ms.length !== frames) throw new Error(`motion atlas: bad anim ${name}`);
    for (const k of a.frames) if (!has(k)) throw new Error(`motion atlas: ${name} names missing frame ${k}`);
    return a;
  };
  const oneShot = (name: string): Cycle => {
    const a = motion.meta.omega.anims[name];
    if (a?.loop !== false || a.ms.length !== a.frames.length) throw new Error(`motion atlas: bad one-shot ${name}`);
    for (const k of a.frames) if (!has(k)) throw new Error(`motion atlas: ${name} names missing frame ${k}`);
    return { frames: a.frames, ms: a.ms };
  };
  const ids = sheet.meta.omega.avatars.map((a) => a.id);
  return {
    sheets: { motion: motion.frames, avatars: sheet.frames },
    walk: ids.map((id) =>
      DIRS.map((d) => {
        const a = anim(`walk/${id}/${d}`, WALK_FRAMES);
        if (a.ms.some((m) => m !== WALK_FRAME_MS)) throw new Error(`motion atlas: walk/${id}/${d} timing`);
        return a.frames;
      }),
    ),
    rest: ids.map((id) => {
      const cycles = (pose: "idle" | "sit"): Cycle[] =>
        DIRS.map((d) => {
          const a = anim(`breathe/${id}/${pose}/${d}`, 2);
          return { frames: a.frames, ms: a.ms };
        });
      return { idle: cycles("idle"), sit: cycles("sit") };
    }),
    wave: ids.map((id) => ({
      idle: DIRS.map((d) => oneShot(`wave/${id}/idle/${d}`)),
      sit: DIRS.map((d) => oneShot(`wave/${id}/sit/${d}`)),
    })),
    emote: { heart: oneShot("emote/heart"), laugh: oneShot("emote/laugh"), question: oneShot("emote/question"), exclaim: oneShot("emote/exclaim"), clap: oneShot("emote/clap") },
  };
}

const cycleOut = { index: 0, nextIn: 0 };

/** The frame a looping cycle shows `t` ms in, and the ms until it changes. Returns a shared object: read it at once. */
export function cycleFrame(ms: readonly number[], t: number): { index: number; nextIn: number } {
  let total = 0;
  for (const m of ms) total += m;
  if (t < 0) {
    cycleOut.index = 0;
    cycleOut.nextIn = (ms[0] ?? 0) - t;
    return cycleOut;
  }
  let r = t % total;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i] ?? 0;
    if (r < m) {
      cycleOut.index = i;
      cycleOut.nextIn = m - r;
      return cycleOut;
    }
    r -= m;
  }
  cycleOut.index = 0;
  cycleOut.nextIn = ms[0] ?? 0;
  return cycleOut;
}

/** The frame a one-shot shows `t` ms in and the ms until it changes; index -1 before it starts and once it's over. Shared object. */
export function oneShotFrame(ms: readonly number[], t: number): { index: number; nextIn: number } {
  if (t < 0) {
    cycleOut.index = -1;
    cycleOut.nextIn = -t;
    return cycleOut;
  }
  let r = t;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i] ?? 0;
    if (r < m) {
      cycleOut.index = i;
      cycleOut.nextIn = m - r;
      return cycleOut;
    }
    r -= m;
  }
  cycleOut.index = -1;
  cycleOut.nextIn = Infinity;
  return cycleOut;
}
