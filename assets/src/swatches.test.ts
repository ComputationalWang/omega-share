import { expect, test } from "bun:test";
import { PIECES } from "./furniture";
import { SWATCHES } from "./owner";

// The editor draws one `ui-swatch-<colour>` per variant of a multi-colour piece; a missing frame is an empty ring (OME-1481).
test("every catalogue colour has an editor swatch", () => {
  const have = new Set<string>(SWATCHES);
  const missing = PIECES.filter((p) => p.colours.length > 1).flatMap((p) => p.colours.filter((c) => !have.has(c)).map((c) => `${p.id}/${c}`));
  expect(missing).toEqual([]);
});
