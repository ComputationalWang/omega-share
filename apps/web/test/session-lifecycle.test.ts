import { describe, expect, test } from "bun:test";
import { awayChanges, presenceHint } from "../src/session-lifecycle";

// OME-911 (ADR 0043): the room tab's lifecycle decisions, kept pure so room.ts and stage.ts only wire them.

describe("presenceHint: which away hint to send, if any", () => {
  test("only on a transition, and only on an open socket", () => {
    expect(presenceHint({ hidden: true, sent: false, open: true })).toBe(true);
    expect(presenceHint({ hidden: false, sent: true, open: true })).toBe(false);
    expect(presenceHint({ hidden: true, sent: true, open: true })).toBeNull();
    expect(presenceHint({ hidden: false, sent: false, open: true })).toBeNull();
    expect(presenceHint({ hidden: true, sent: false, open: false })).toBeNull();
  });

  test("after a rejoin the server has cleared away, so a tab still hidden says so again", () => {
    // The session sink resets `sent` to false on each snapshot; a hidden tab then owes one hint.
    expect(presenceHint({ hidden: true, sent: false, open: true })).toBe(true);
  });
});

describe("awayChanges: dim and undim only the members whose away flag changed", () => {
  const m = (id: string, away?: boolean) => (away === undefined ? { id } : { id, away });

  test("nothing changes → nothing to do", () => {
    expect(awayChanges(new Set(["a"]), [m("a", true), m("b")])).toEqual({ on: [], off: [], now: new Set(["a"]) });
  });

  test("newly away, back, and gone", () => {
    const r = awayChanges(new Set(["a", "gone"]), [m("a", false), m("b", true), m("c")]);
    expect(r.on).toEqual(["b"]);
    expect(r.off.sort()).toEqual(["a", "gone"]);
    expect(r.now).toEqual(new Set(["b"]));
  });
});
