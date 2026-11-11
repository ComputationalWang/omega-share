import { describe, expect, test } from "bun:test";
import type { MemberId } from "@omega/shared";
import { autoHair } from "../src/auto-hair";

const id = (s: string): MemberId => s as MemberId;
const m = (s: string, avatar: number, hair?: number) => ({ id: id(s), avatar, ...(hair === undefined ? {} : { hair }) });

// OME-2559: an auto guest whose avatar is already in the room takes the first hair nobody on that avatar wears.
describe("autoHair", () => {
  test("an avatar nobody else wears keeps its hair", () => {
    expect(autoHair([m("a", 1), m("me", 0)], id("me"), new Set([id("a")]), 6)).toBeNull();
  });
  test("the same avatar and hair as an earlier member: the first hair no one on that avatar wears", () => {
    expect(autoHair([m("a", 0), m("me", 0)], id("me"), new Set([id("a")]), 6)).toBe(1);
    expect(autoHair([m("a", 0), m("b", 0, 1), m("c", 1, 2), m("me", 0)], id("me"), new Set([id("a"), id("b"), id("c")]), 6)).toBe(2);
  });
  test("the same avatar but a different hair is left alone", () => {
    expect(autoHair([m("a", 0, 3), m("me", 0)], id("me"), new Set([id("a")]), 6)).toBeNull();
  });
  test("only an earlier member makes me move: a later joiner is the one who moves", () => {
    expect(autoHair([m("a", 0), m("me", 0)], id("me"), new Set(), 6)).toBeNull();
  });
  test("every hair taken: keep today's hair", () => {
    const others = [0, 1, 2].map((h) => m(`o${h}`, 0, h));
    expect(autoHair([...others, m("me", 0)], id("me"), new Set(others.map((o) => o.id)), 3)).toBeNull();
  });
  test("not in the room: nothing", () => {
    expect(autoHair([m("a", 0)], id("me"), new Set([id("a")]), 6)).toBeNull();
  });
});
