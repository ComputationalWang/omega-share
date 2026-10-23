// The lying pose's sheet (assets/avatars/lying.png + .json, CC BY-SA 4.0, OME-1687): a lazy chunk room-view.ts imports only
// once someone lies down (OME-1691). Frames keep the avatar sheets' palette slots, so shirt tints and hair colours apply.
import lyingJson from "../../../../assets/avatars/lying.json";
import pngUrl from "../../../../assets/avatars/lying.png?url";
import * as v from "valibot";
import { once } from "../atlas-sheet";
import { FramesSchema } from "./motion";
import { tintableSheets } from "./tint-sheets";

/** Load once; a failed load is forgotten so a later lier can retry. */
export const loadLieAtlas = once(() => tintableSheets([pngUrl], [v.parse(v.object({ frames: FramesSchema }), lyingJson).frames]));
