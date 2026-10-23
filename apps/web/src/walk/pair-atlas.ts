// The Dank Dungeon's emote poses (assets/avatars/dungeon.png + .json, CC BY-SA 4.0, OME-1670): bendover and thrust. A lazy
// chunk room-view.ts imports only once the room's layout has `pairs` (OME-1672). Frames keep the avatar sheets' palette slots,
// so shirt tints and hair colours apply.
import dungeonJson from "../../../../assets/avatars/dungeon.json";
import pngUrl from "../../../../assets/avatars/dungeon.png?url";
import { once } from "../atlas-sheet";
import { FramesSchema } from "./motion";
import * as v from "valibot";
import { tintableSheets } from "./tint-sheets";

/** Load once; a failed load is forgotten so a later pair room can retry. */
export const loadPairAtlas = once(() => tintableSheets([pngUrl], [v.parse(v.object({ frames: FramesSchema }), dungeonJson).frames]));
