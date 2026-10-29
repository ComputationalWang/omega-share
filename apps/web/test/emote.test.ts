import { describe, expect, test } from "bun:test";
import { EMOTE_BURST, EMOTE_KINDS, EMOTE_REFILL_MS } from "@omega/shared";
import { parseRecipes } from "../src/audio/recipes";
import shipped from "../../../assets/sound/recipes.json";
import { EMOTE_MARGIN_MS, EMOTE_SOUNDS, PICKER_KINDS, createEmoteBucket, kindForKey } from "../src/emote/emotes";

// OME-415: the emote picker's order and shortcuts (set (i): 5 stickers, the groove, the wave, then OME-1121's cheer and
// yawn; keys 1–8), and the
// local bucket that mirrors the server's (C2: EMOTE_BURST at once, then one per EMOTE_REFILL_MS), a little slower,
// so the key cools before the server would answer rate_limited (which would cool chat too).

describe("sounds (OME-1969)", () => {
  test("every emote has its own shipped recipe, and no two recipes are the same sound", () => {
    const sounds = parseRecipes(shipped)?.sounds ?? {};
    const names = EMOTE_KINDS.map((k) => EMOTE_SOUNDS[k]);
    expect(new Set(names).size).toBe(EMOTE_KINDS.length);
    for (const n of names) expect(sounds[n]).toBeDefined();
    expect(new Set(names.map((n) => JSON.stringify(sounds[n]))).size).toBe(EMOTE_KINDS.length);
  });
});

describe("picker", () => {
  test("is the five stickers in the atlas order, the wave, cheer and yawn, then dance: every EMOTE_KINDS once", () => {
    expect(PICKER_KINDS).toEqual(["heart", "laugh", "question", "exclaim", "clap", "wave", "cheer", "yawn", "dance"]);
    expect([...PICKER_KINDS].sort()).toEqual([...EMOTE_KINDS].sort());
  });

  test("keys 1–8 pick in that order; anything else picks nothing", () => {
    expect(kindForKey("1")).toBe("heart");
    expect(kindForKey("5")).toBe("clap");
    expect(kindForKey("6")).toBe("wave");
    expect(kindForKey("7")).toBe("cheer");
    expect(kindForKey("8")).toBe("yawn");
    expect(kindForKey("9")).toBe("dance");
    for (const k of ["0", "a", "Enter", "", "11"]) expect(kindForKey(k)).toBeNull();
  });
});

describe("emote bucket", () => {
  const refill = EMOTE_REFILL_MS + EMOTE_MARGIN_MS;

  test("a burst of EMOTE_BURST, then empty until a token refills", () => {
    const b = createEmoteBucket(0);
    for (let i = 0; i < EMOTE_BURST; i++) expect(b.take(0)).toBe(true);
    expect(b.take(10)).toBe(false);
    expect(b.readyAt(10)).toBe(refill);
    expect(b.take(refill - 1)).toBe(false);
    expect(b.take(refill)).toBe(true);
    expect(b.take(refill)).toBe(false);
  });

  test("readyAt is now (or earlier) while a token is left", () => {
    const b = createEmoteBucket(0);
    expect(b.readyAt(5)).toBeLessThanOrEqual(5);
    b.take(5);
    expect(b.readyAt(5)).toBeLessThanOrEqual(5);
  });

  test("refills no higher than the burst, however long it rests", () => {
    const b = createEmoteBucket(0);
    b.take(0);
    let taken = 0;
    while (b.take(1_000_000)) taken++;
    expect(taken).toBe(EMOTE_BURST);
  });

  test("never runs ahead of the server: sending whenever the bucket allows stays under the server's own rate", () => {
    const b = createEmoteBucket(0);
    let sent = 0;
    for (let t = 0; t <= 60_000; t += 7) if (b.take(t)) sent++;
    expect(sent).toBeLessThanOrEqual(EMOTE_BURST + Math.floor(60_000 / EMOTE_REFILL_MS));
    expect(sent).toBeGreaterThanOrEqual(EMOTE_BURST + Math.floor(60_000 / refill) - 1);
  });
});
