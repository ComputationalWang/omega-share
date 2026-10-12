import * as v from "valibot";
import { RoomPresetIdSchema, type RoomPresetId } from "@omega/shared";
import manifest from "../../../assets/presets/presets.json";

// The create-room form's presets (OME-910; art and copy: assets/presets/presets.json). Only the id travels: the server
// resolves it to a layout, so the layout files are never shipped. The thumbnails are separate files (preset-thumbs.ts).

const ManifestSchema = v.object({
  default: RoomPresetIdSchema,
  thumb: v.object({ w: v.number(), h: v.number() }),
  presets: v.array(v.object({ id: RoomPresetIdSchema, name: v.string(), blurb: v.string() })),
});

const parsed = v.parse(ManifestSchema, manifest);

export interface PresetInfo {
  readonly id: RoomPresetId;
  readonly name: string;
  readonly blurb: string;
}

export const PRESETS: readonly PresetInfo[] = parsed.presets;
export const DEFAULT_PRESET: RoomPresetId = parsed.default;
/** The thumbnails' pixel size, set on every img so the form doesn't shift as they load. */
export const PRESET_THUMB: { readonly w: number; readonly h: number } = { w: parsed.thumb.w, h: parsed.thumb.h };
