// Set (a) avatars + set (d) motion + set (p) expressions sheets (assets/avatars, CC BY-SA 4.0). Its own chunk: room-view.ts imports it once
// the room has people in it (after join), so first paint and TTI never pay for it (ADR 0010).
import avatarsJson from "../../../../assets/avatars/avatars.json";
import avatarsPng from "../../../../assets/avatars/avatars.png?url";
import expressionsJson from "../../../../assets/avatars/expressions.json";
import expressionsPng from "../../../../assets/avatars/expressions.png?url";
import motionJson from "../../../../assets/avatars/motion.json";
import motionPng from "../../../../assets/avatars/motion.png?url";
import { parseMotion, type MotionFrames } from "./motion";
import { tintableSheets, type TintableSheets } from "./tint-sheets";

export interface MotionAtlas extends TintableSheets {
  readonly frames: MotionFrames;
}

let loading: Promise<MotionAtlas> | null = null;

/** Loads once; a failed load is forgotten so a later call can retry. */
export function loadMotionAtlas(): Promise<MotionAtlas> {
  loading ??= load().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function load(): Promise<MotionAtlas> {
  const frames = parseMotion(motionJson, avatarsJson, expressionsJson);
  const sheets = await tintableSheets([motionPng, avatarsPng, expressionsPng], [frames.sheets.motion, frames.sheets.avatars, frames.sheets.expressions]);
  return { frames, ...sheets };
}
