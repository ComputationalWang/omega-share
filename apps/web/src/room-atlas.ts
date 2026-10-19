// Room atlas (assets/room, CC BY-SA 4.0, OME-31): plank floor, the two back walls and the room-atlas kinds (armchair, tv,
// rug, lamp, plant). Its own chunk, fetched after the room's first layout, never on first paint (OME-1062).
import * as v from "valibot";
import json from "../../../assets/room/room.json";
import pngUrl from "../../../assets/room/room.png?url";
import { loadSheet, once, type Sheet } from "./atlas-sheet";
import { RoomManifestSchema, type RoomManifest } from "./furniture";

export interface RoomAtlas extends Sheet {
  /** The sheet's URL: a recolour (OME-1463) swaps a copy of its bytes. */
  readonly url: string;
  readonly manifest: RoomManifest;
}

export const loadRoomAtlas = once(async (): Promise<RoomAtlas> => {
  const manifest = v.parse(RoomManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
