// The sound recipes (OME-1638, format in FORMAT.md): oscillators, noise and envelopes as data. Parsed strictly at the
// boundary: a recipe file that doesn't fit is rejected whole, so a typo shows up in a test, not as a half-played sound.
import * as v from "valibot";

const seconds = v.pipe(v.number(), v.minValue(0), v.maxValue(30));
const level = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const hz = v.pipe(v.number(), v.minValue(10), v.maxValue(20000));

const EnvSchema = v.strictObject({
  a: v.optional(seconds),
  d: v.optional(seconds),
  s: v.optional(level),
  hold: v.optional(seconds),
  r: v.optional(seconds),
  delay: v.optional(seconds),
});

const FilterSchema = v.strictObject({
  type: v.picklist(["lowpass", "highpass", "bandpass"]),
  freq: hz,
  q: v.optional(v.pipe(v.number(), v.minValue(0.0001), v.maxValue(100))),
});

const common = { env: EnvSchema, gain: v.optional(level), filter: v.optional(FilterSchema) };
const LayerSchema = v.union([
  v.strictObject({ osc: v.picklist(["sine", "triangle", "square", "sawtooth"]), freq: hz, to: v.optional(hz), ...common }),
  v.strictObject({ noise: v.picklist(["white", "pink", "brown"]), ...common }),
]);

const RecipeSchema = v.strictObject({
  gain: level,
  loop: v.optional(v.boolean()),
  layers: v.pipe(v.array(LayerSchema), v.minLength(1), v.maxLength(8)),
});

const RecipesSchema = v.strictObject({
  version: v.literal(1),
  sounds: v.record(v.pipe(v.string(), v.maxLength(32)), RecipeSchema),
});

export type Layer = v.InferOutput<typeof LayerSchema>;
export type Recipe = v.InferOutput<typeof RecipeSchema>;
export type Recipes = v.InferOutput<typeof RecipesSchema>;
export type Env = v.InferOutput<typeof EnvSchema>;

/** The recipes, or null if `json` isn't exactly the format. */
export function parseRecipes(json: unknown): Recipes | null {
  const r = v.safeParse(RecipesSchema, json);
  return r.success ? r.output : null;
}
