// The sound engine's lazy chunk (OME-1638): room.ts imports it after the room is up, never on a first page load. The
// Designer's recipes (assets/sound/recipes.json, OME-1642) if they're in the tree, else the placeholders; either way
// parsed at the boundary, and a file that doesn't parse leaves the room silent rather than half-playing it.
import { createSound, type Sound, type SoundOptions } from "./engine";
import { PLACEHOLDER_RECIPES } from "./placeholder";
import { parseRecipes } from "./recipes";

export type { Sound } from "./engine";
export { floorKinds, type FloorKind } from "./floor";

export async function loadSound(o: Omit<SoundOptions, "recipes" | "makeContext">): Promise<Sound> {
  // A glob, so the build doesn't depend on the file being there yet.
  const files = import.meta.glob<unknown>("../../../../assets/sound/recipes.json", { import: "default" });
  const load = Object.values(files)[0];
  const json = load === undefined ? PLACEHOLDER_RECIPES : await load();
  const recipes = parseRecipes(json);
  if (recipes === null) console.warn("sound: assets/sound/recipes.json doesn't match the recipe format (FORMAT.md); no sound");
  return createSound({ ...o, recipes: recipes ?? { version: 1, sounds: {} }, makeContext: () => new AudioContext() });
}
