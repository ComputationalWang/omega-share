// OME-2253: Pip's beanie must not read as a crowned Pip's gold crown or ginger hair (judge round 8, 3× seated crop).
import { expect, test } from "bun:test";
import { AVATARS } from "./avatars";
import { RAMPS } from "./palette";

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const apart = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

test("Pip's beanie hue sits ≥ 30° from the crown's mustard and Pip's ginger hair", () => {
  const pip = AVATARS.find((a) => a.id === "pip");
  const knit = pip?.roles["A"]?.ramp;
  if (!knit) throw new Error("pip has no beanie role A");
  for (const other of ["mustard", "hairGinger"] as const)
    for (const k of [0, 1, 2] as const) expect(apart(hue(RAMPS[knit][k]), hue(RAMPS[other][k]))).toBeGreaterThanOrEqual(30);
});
