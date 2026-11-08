import { describe, expect, test } from "bun:test";
import { wrapLines } from "../src/scene-bubbles";

// One px per character: the breaks are easy to read off.
const width = (s: string): number => s.length;

describe("wrapLines (OME-2307 3c: the painted words break where the DOM's did)", () => {
  test("a line that fits is one line", () => {
    expect(wrapLines("hello you", 20, 0, 3, width)).toEqual(["hello you"]);
  });
  test("it breaks between words", () => {
    expect(wrapLines("aaa bbb ccc", 7, 0, 3, width)).toEqual(["aaa bbb", "ccc"]);
  });
  test("the speaker's name takes room on the first line", () => {
    expect(wrapLines("aaa bbb", 7, 4, 3, width)).toEqual(["aaa", "bbb"]);
  });
  test("one unbroken word breaks anywhere (overflow-wrap: anywhere)", () => {
    expect(wrapLines("abcdefghij", 4, 0, 3, width)).toEqual(["abcd", "efgh", "ij"]);
  });
  test("past the line limit the last line is cut with an ellipsis", () => {
    expect(wrapLines("aaaa bbbb cccc dddd", 4, 0, 3, width)).toEqual(["aaaa", "bbbb", "ccc…"]);
  });
});
