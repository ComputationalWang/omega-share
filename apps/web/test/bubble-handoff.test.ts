import { describe, expect, test } from "bun:test";
import { createHandoff } from "../src/bubbles/handoff";
import type { Bubble } from "../src/state";

const b = (id: number, memberId: string, text: string): Bubble => ({ id, memberId, text, expiresAt: 6000 + id });

describe("bubble handoff (OME-809)", () => {
  test("two lines from one speaker that arrive before one stage update both reach the floats, oldest first", () => {
    const h = createHandoff();
    const said: string[] = [];
    h.hand([b(1, "m1", "one"), b(2, "m1", "two")], (x) => {
      said.push(x.text);
      return true;
    });
    expect(said).toEqual(["one", "two"]);
  });

  test("a bubble already handed over is not said again; a new one is", () => {
    const h = createHandoff();
    const said: string[] = [];
    const say = (x: Bubble): boolean => {
      said.push(x.text);
      return true;
    };
    h.hand([b(1, "m1", "one")], say);
    // A pop-out window parses fresh objects every update: equal ids are the same message.
    h.hand([b(1, "m1", "one")], say);
    h.hand([b(1, "m1", "one"), b(2, "m1", "two")], say);
    expect(said).toEqual(["one", "two"]);
  });

  test("a bubble the floats couldn't take yet (no position) is offered again next update", () => {
    const h = createHandoff();
    let ready = false;
    const said: string[] = [];
    const say = (x: Bubble): boolean => {
      if (!ready) return false;
      said.push(x.text);
      return true;
    };
    h.hand([b(1, "m1", "one")], say);
    ready = true;
    h.hand([b(1, "m1", "one")], say);
    expect(said).toEqual(["one"]);
  });

  test("it forgets bubbles that left the state, so it holds no more than the state does", () => {
    const h = createHandoff();
    const say = (): boolean => true;
    for (let i = 1; i <= 100; i++) h.hand([b(i, "m1", "x")], say);
    expect(h.size()).toBe(1);
    h.hand([], say);
    expect(h.size()).toBe(0);
  });
});
