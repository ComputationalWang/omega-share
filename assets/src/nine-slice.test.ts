// OME-2128: a var() anywhere in a border-image shorthand makes Blink re-resolve its image on every restyle of the element,
// and a new image repaints it. The room's name tags (.ui-tag) restyle every walking frame (their translate), so each one
// was re-recorded every frame. A 9-slice's width is `1`: one border-width, which already follows --ui-px.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "ui", "reference.css"), "utf8");

test("no border-image shorthand in reference.css carries a var()", () => {
  const shorthands = [...css.matchAll(/^(\.[^{]+?) \{[^}]*?border-image: ([^;]+);/gm)].map(([, selector, value]) => ({ selector, value: value?.replace(/url\("[^"]+"\)/, "url()") }));
  expect(shorthands.map((s) => s.selector)).toContain(".ui-tag");
  expect(shorthands.filter((s) => s.value?.includes("var(") === true)).toEqual([]);
});
