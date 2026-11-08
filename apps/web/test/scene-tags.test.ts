import { describe, expect, test } from "bun:test";
import { fitText } from "../src/scene-tags";

// One px per character: the cut is easy to read off.
const width = (s: string): number => s.length;

describe("fitText (OME-2307: the painted name ellipsizes as the DOM's did)", () => {
  test("a name that fits is unchanged", () => {
    expect(fitText("Juno", 4, width)).toBe("Juno");
  });
  test("a long name is cut to fit with its ellipsis", () => {
    expect(fitText("Juniper", 5, width)).toBe("Juni…");
  });
  test("no room: only the ellipsis", () => {
    expect(fitText("Juniper", 0, width)).toBe("…");
  });
});
