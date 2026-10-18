import { describe, expect, test } from "bun:test";
import { APPLAUSE_COOLDOWN_MS, APPLAUSE_WINDOW_MS, createApplause } from "../src/emote/applause";

// OME-1389: 3 different members clap or cheer within 3 s → one burst; then at most one per 10 s.
describe("createApplause", () => {
  test("three members clapping or cheering within the window: the third fires", () => {
    const a = createApplause();
    expect(a.push("a", "clap", 0)).toBe(false);
    expect(a.push("b", "cheer", 1000)).toBe(false);
    expect(a.push("c", "clap", 2999)).toBe(true);
  });

  test("one member clapping three times is not a crowd", () => {
    const a = createApplause();
    expect(a.push("a", "clap", 0)).toBe(false);
    expect(a.push("a", "clap", 100)).toBe(false);
    expect(a.push("a", "cheer", 200)).toBe(false);
    expect(a.push("b", "clap", 300)).toBe(false);
  });

  test("other emotes don't count", () => {
    const a = createApplause();
    a.push("a", "clap", 0);
    a.push("b", "heart", 10);
    expect(a.push("c", "wave", 20)).toBe(false);
  });

  test("a clap older than the window has run out", () => {
    const a = createApplause();
    a.push("a", "clap", 0);
    a.push("b", "clap", 1000);
    expect(a.push("c", "clap", APPLAUSE_WINDOW_MS + 1)).toBe(false);
    expect(a.push("a", "clap", APPLAUSE_WINDOW_MS + 2)).toBe(true);
  });

  test("at most one burst per cooldown", () => {
    const a = createApplause();
    a.push("a", "clap", 0);
    a.push("b", "clap", 1);
    expect(a.push("c", "clap", 2)).toBe(true);
    a.push("a", "clap", 3000);
    a.push("b", "clap", 3001);
    expect(a.push("c", "clap", 3002)).toBe(false);
    a.push("a", "clap", APPLAUSE_COOLDOWN_MS);
    a.push("b", "clap", APPLAUSE_COOLDOWN_MS + 1);
    expect(a.push("c", "clap", APPLAUSE_COOLDOWN_MS + 2)).toBe(true);
  });
});
