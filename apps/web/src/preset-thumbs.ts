// Vite-only: the preset thumbnails as files (`?url`; vite.config.ts keeps assets/presets out of the inline limit).
import type { RoomPresetId } from "@omega/shared";
import cafe from "../../../assets/presets/thumbs/cafe.png?url";
import cinema from "../../../assets/presets/thumbs/cinema.png?url";
import classic from "../../../assets/presets/thumbs/classic.png?url";
import empty from "../../../assets/presets/thumbs/empty.png?url";
import living from "../../../assets/presets/thumbs/living.png?url";
import lounge from "../../../assets/presets/thumbs/lounge.png?url";

export const PRESET_THUMBS: Readonly<Record<RoomPresetId, string>> = { classic, cinema, living, lounge, cafe, empty };
