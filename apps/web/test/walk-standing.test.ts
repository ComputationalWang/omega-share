import { describe, expect, test } from "bun:test";
import type { MemberId } from "@omega/shared";
import { standingSpots } from "../src/walk/standing";

// OME-408 review: standing spots are handed out in member order, so one departure shifted everyone behind them and
// they all walked. A member keeps their spot while it exists; newcomers take the lowest free one.

const ids = (...xs: string[]): MemberId[] => xs;
const spots = (m: ReadonlyMap<MemberId, number>): Record<string, number> => Object.fromEntries(m);

describe("standingSpots", () => {
  test("fresh: in order, front spots first", () => {
    expect(spots(standingSpots(ids("a", "b", "c"), 12, new Map()))).toEqual({ a: 0, b: 1, c: 2 });
  });

  test("someone leaving moves nobody else", () => {
    const before = standingSpots(ids("a", "b", "c"), 12, new Map());
    expect(spots(standingSpots(ids("b", "c"), 12, before))).toEqual({ b: 1, c: 2 });
  });

  test("a newcomer takes the lowest free spot", () => {
    const prev = new Map<MemberId, number>([["b", 1], ["c", 2]]);
    expect(spots(standingSpots(ids("b", "c", "d", "e"), 12, prev))).toEqual({ b: 1, c: 2, d: 0, e: 3 });
  });

  test("someone who sat down and stands up again is a newcomer to the standing spots", () => {
    const prev = new Map<MemberId, number>([["a", 0], ["b", 1]]);
    const seated = standingSpots(ids("b"), 12, prev); // a took a seat
    expect(spots(standingSpots(ids("a", "b"), 12, seated))).toEqual({ a: 0, b: 1 });
  });

  test("fewer spots (a new layout): spots that are gone are handed out again; extras get none", () => {
    const prev = new Map<MemberId, number>([["a", 5], ["b", 0]]);
    expect(spots(standingSpots(ids("a", "b", "c"), 2, prev))).toEqual({ a: 1, b: 0 });
  });
});
