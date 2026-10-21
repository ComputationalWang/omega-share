// The sound engine's lazy chunk (OME-1638): room.ts imports it after the room is up, never on a first page load, with
// the Designer's recipes (assets/sound/recipes.json, OME-1642) in it. They're parsed at the boundary: a file that doesn't
// parse leaves the room silent rather than half-playing it.
import json from "../../../../assets/sound/recipes.json";
import { createSound, type Sound, type SoundOptions } from "./engine";
import { parseRecipes } from "./recipes";

export type { Sound } from "./engine";
export { floorKinds, type FloorKind } from "./floor";

export function loadSound(o: Omit<SoundOptions, "recipes" | "makeContext" | "makeOffline">): Sound {
  const recipes = parseRecipes(json);
  if (recipes === null) console.warn("sound: assets/sound/recipes.json doesn't match the recipe format (FORMAT.md); no sound");
  return createSound({
    ...o,
    recipes: recipes ?? { version: 1, sounds: {} },
    makeContext: () => new AudioContext(),
    makeOffline: (length, sampleRate) => new OfflineAudioContext(1, length, sampleRate),
  });
}
