import { describe, expect, test } from "bun:test";
import { walkedInWindow } from "./walkers";

// OME-911 (ADR 0043): standing slots are stable, so a bot that sits and stands up again inside the window ends where it
// started. The walk-tiers guard counts walkers, not net displacement: a tag that moved, or a bot that changed seat.
describe("walkedInWindow", () => {
  const start = { "w25-bot-1": "translate(1px, 1px)", "w25-bot-2": "translate(2px, 2px)", "w25-bot-3": "translate(3px, 3px)" };

  test("a tag that ends elsewhere walked", () => {
    expect(walkedInWindow(start, { ...start, "w25-bot-1": "translate(9px, 9px)" }, [])).toBe(1);
  });

  test("a round trip back to the same slot still walked: its seat changed in the window", () => {
    expect(walkedInWindow(start, start, ["w25-bot-2"])).toBe(1);
  });

  test("each bot counts once; names that aren't bot tags (the observer) don't count", () => {
    expect(walkedInWindow(start, { ...start, "w25-bot-1": "x" }, ["w25-bot-1", "w25-bot-1", "w25-obs-1"])).toBe(1);
  });

  test("nobody moved and no seat changed: zero", () => {
    expect(walkedInWindow(start, start, [])).toBe(0);
  });
});
