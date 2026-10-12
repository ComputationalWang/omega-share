// The judged D1 room presets (OME-906, CC BY-SA 4.0, assets/presets). A created room starts from the layout of the
// preset id it names (OME-910); the id is checked by CreateRoomRequestSchema, never a layout from the request.
import * as v from "valibot";
import { RoomLayoutSchema, type RoomLayout, type RoomPresetId } from "@omega/shared";
import cafe from "../../../assets/presets/cafe.json";
import cinema from "../../../assets/presets/cinema.json";
import classic from "../../../assets/presets/classic.json";
import empty from "../../../assets/presets/empty.json";
import living from "../../../assets/presets/living.json";
import lounge from "../../../assets/presets/lounge.json";

// Parsed once at startup: a bad asset fails the boot, not a creation.
const parse = (id: RoomPresetId, json: unknown): RoomLayout => {
  const parsed = v.safeParse(RoomLayoutSchema, json);
  if (!parsed.success) throw new Error(`assets/presets/${id}.json is not a valid room layout`);
  return parsed.output;
};

const PRESET_LAYOUTS: Readonly<Record<RoomPresetId, RoomLayout>> = {
  classic: parse("classic", classic),
  cinema: parse("cinema", cinema),
  living: parse("living", living),
  lounge: parse("lounge", lounge),
  cafe: parse("cafe", cafe),
  empty: parse("empty", empty),
};

export const presetLayout = (id: RoomPresetId): RoomLayout => PRESET_LAYOUTS[id];
