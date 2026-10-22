import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MemberId, Reaction, ReactionKind } from "@omega/shared";

// OME-1628: the moments strip under the player: a density bar and up to 8 pips that seek, redrawn only on a reaction.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const r = (mediaMs: number, kind: ReactionKind = "heart"): Reaction => ({ memberId: "m1" as MemberId, kind, mediaMs });

describe("moments", () => {
  test("a single reaction's pip sits at its own position, within 1 s", async () => {
    const { moments } = await import("../src/moments/strip");
    const m = moments([r(61_400)], 600_000);
    expect(m.pips).toHaveLength(1);
    expect(Math.abs((m.pips[0]?.mediaMs ?? -1) - 61_400)).toBeLessThanOrEqual(1000);
  });

  test("mediaMs past the item's end is clamped to the duration", async () => {
    const { moments } = await import("../src/moments/strip");
    const m = moments([r(900_000)], 600_000);
    expect(m.pips[0]?.mediaMs).toBe(600_000);
    expect(m.density.at(-1)).toBe(1);
  });

  test("at most 8 pips, the densest windows first, each with its most common kind", async () => {
    const { moments, STRIP_PIPS } = await import("../src/moments/strip");
    const list: Reaction[] = [];
    // 12 separate windows; window i has i + 1 reactions.
    for (let i = 0; i < 12; i++) for (let k = 0; k <= i; k++) list.push(r(i * 50_000 + 10_000 + k * 100, i === 11 ? "laugh" : "heart"));
    const m = moments(list, 600_000);
    expect(STRIP_PIPS).toBe(8);
    expect(m.pips).toHaveLength(8);
    expect(m.pips[0]?.count).toBe(12);
    expect(m.pips[0]?.kind).toBe("laugh");
    expect(Math.min(...m.pips.map((p) => p.count))).toBe(5);
  });

  test("no duration, no moments", async () => {
    const { moments } = await import("../src/moments/strip");
    expect(moments([r(1000)], 0).pips).toHaveLength(0);
  });
});

describe("createMomentsStrip", () => {
  async function setup(canSeek = true) {
    const { createMomentsStrip } = await import("../src/moments/strip");
    const seeks: number[] = [];
    const strip = createMomentsStrip({ seek: (s) => (seeks.push(s), true) });
    strip.setControl(canSeek);
    document.body.replaceChildren(strip.root);
    const pips = (): HTMLButtonElement[] => [...strip.root.querySelectorAll<HTMLButtonElement>("button")].filter((b) => !b.hidden);
    return { strip, seeks, pips };
  }

  test("shows a pip per moment at its position; clicking it seeks there", async () => {
    const { strip, seeks, pips } = await setup();
    strip.render([r(150_000), r(150_200)], 600_000);
    expect(pips()).toHaveLength(1);
    expect(pips()[0]?.style.left).toBe("25%");
    pips()[0]?.click();
    expect(seeks).toEqual([150]);
  });

  test("the room's control policy says no: the pip can't seek", async () => {
    const { strip, seeks, pips } = await setup(false);
    strip.render([r(150_000)], 600_000);
    expect(pips()[0]?.disabled).toBe(true);
    pips()[0]?.click();
    expect(seeks).toEqual([]);
  });

  test("the strip hides with nothing to show and reuses its nodes", async () => {
    const { strip, pips } = await setup();
    strip.render([], 600_000);
    expect(strip.root.hidden).toBe(true);
    strip.render([r(1000)], 600_000);
    const first = pips()[0];
    strip.render([r(1000), r(1100)], 600_000);
    expect(strip.root.hidden).toBe(false);
    expect(pips()[0]).toBe(first);
    expect(strip.root.querySelectorAll("button")).toHaveLength(8);
  });
});
