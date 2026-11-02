import { describe, expect, test } from "bun:test";

// OME-2175: on touch, :hover sticks after a tap, so the seat's rose tint stayed over the avatar who sat there (phone).
const css = await Bun.file(new URL("../src/room.css", import.meta.url)).text();
/** Every top-level `selector { body }` rule outside `@media (hover: hover)`, the only place a hover fill may live. */
const outsideHover = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media \(hover: hover\) \{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "");
const rules = [...outsideHover.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]?.trim() ?? "", body: m[2] ?? "" }));

describe("the seat's hover tint (OME-2175)", () => {
  test("a hover fill only applies where the device can hover", () => {
    expect(css).toMatch(/@media \(hover: hover\) \{[^}]*\.seat:hover[^}]*background:/);
    const sticky = rules.filter((r) => r.selector.includes('.seat:hover') && /background:\s*rgb/.test(r.body));
    expect(sticky).toEqual([]);
  });

  test("a taken seat that isn't yours gets no fill on hover or focus, and keyboard focus keeps its ring", () => {
    const taken = rules.find((r) => r.selector.includes('.seat[data-occupied="true"]:not(.mine):hover') && r.selector.includes('.seat[data-occupied="true"]:not(.mine):focus-visible'));
    expect(taken?.body).toMatch(/background:\s*transparent/);
    expect(taken?.body).not.toMatch(/outline/);
    expect(rules.find((r) => r.selector === ".seat:focus-visible")?.body).toMatch(/outline: 4px solid/);
  });
});

// OME-2176: the sofa's lie key sits right over a sitter's head; it follows the seat's rule.
describe("the lie key's hover tint (OME-2176)", () => {
  test("a hover fill only applies where the device can hover, and never on a key someone else holds (disabled)", () => {
    expect(css).toMatch(/@media \(hover: hover\) \{[^}]*\.lie-key:not\(:disabled\):hover[^}]*background:/);
    const sticky = rules.filter((r) => r.selector.includes(".lie-key:hover") && /background:\s*rgb/.test(r.body));
    expect(sticky).toEqual([]);
  });

  test("keyboard focus keeps its ring", () => {
    expect(rules.find((r) => r.selector === ".lie-key:focus-visible")?.body).toMatch(/outline: 4px solid/);
  });
});
