import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Reaction, ReactionKind } from "@omega/shared";

// OME-1629: the end-of-video recap card: the top 3 moments, who watched (as text) and the reaction counts.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const r = (mediaMs: number, kind: ReactionKind = "heart"): Reaction => ({ memberId: "m1", kind, mediaMs });

/** Window i (i = 0…4) at i × 100 s holds i + 1 reactions. */
const windows = (): Reaction[] => {
  const list: Reaction[] = [];
  for (let i = 0; i < 5; i++) for (let k = 0; k <= i; k++) list.push(r(i * 100_000 + 5_000 + k * 100, i === 4 ? "laugh" : "heart"));
  return list;
};

describe("recapOf", () => {
  test("no reactions, no recap", async () => {
    const { recapOf } = await import("../src/moments/recap");
    expect(recapOf([], 600_000, ["Ada"])).toBeNull();
  });

  test("the top 3 moments are the densest windows, busiest first, with the counts per kind", async () => {
    const { recapOf, RECAP_MOMENTS } = await import("../src/moments/recap");
    const d = recapOf(windows(), 600_000, ["Ada", "Bo"]);
    expect(RECAP_MOMENTS).toBe(3);
    expect(d?.moments.map((m) => m.count)).toEqual([5, 4, 3]);
    expect(d?.moments[0]?.kind).toBe("laugh");
    expect(Math.abs((d?.moments[0]?.mediaMs ?? -1) - 405_000)).toBeLessThanOrEqual(1000);
    expect(d?.counts).toEqual({ heart: 10, laugh: 5, wow: 0, clap: 0 });
    expect(d?.watched).toEqual(["Ada", "Bo"]);
  });

  test("an unknown duration (0) still finds the moments", async () => {
    const { recapOf } = await import("../src/moments/recap");
    expect(recapOf(windows(), 0, [])?.moments.map((m) => m.count)).toEqual([5, 4, 3]);
  });
});

describe("recap card", () => {
  const evil = '<img src=x onerror="alert(1)">';

  test("show renders the moments, the nicknames as text and the counts; showing again replaces them", async () => {
    const { createRecapCard, recapOf } = await import("../src/moments/recap");
    const card = createRecapCard();
    document.body.append(card.root);
    expect(card.root.hidden).toBe(true);
    const d = recapOf(windows(), 600_000, [evil, "Bo"]);
    if (d === null) throw new Error("no recap");
    card.show(d);
    card.show(d);
    expect(card.root.hidden).toBe(false);
    expect(card.root.querySelectorAll('[data-testid="recap-moment"]')).toHaveLength(3);
    expect(card.root.querySelector("img")).toBeNull();
    expect(card.root.querySelector('[data-testid="recap-watched"]')?.textContent).toContain(evil);
    expect(card.root.querySelector('[data-testid="recap-moment"]')?.textContent).toContain("6:45");
    const counts = card.root.querySelector('[data-testid="recap-counts"]')?.textContent ?? "";
    expect(counts).toContain("10");
    expect(counts).toContain("5");
    card.root.remove();
  });

  test("Esc dismisses it, and once hidden Esc is no longer heard", async () => {
    const { createRecapCard, recapOf } = await import("../src/moments/recap");
    const card = createRecapCard();
    const d = recapOf(windows(), 600_000, ["Ada"]);
    if (d === null) throw new Error("no recap");
    card.show(d);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card.root.hidden).toBe(true);
    // Hidden: a later Esc must not reach the card (its listener is gone), so a second card shown meanwhile stays open.
    let heard = 0;
    const spy = (): void => {
      heard++;
    };
    window.addEventListener("keydown", spy);
    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(ev);
    window.removeEventListener("keydown", spy);
    expect(heard).toBe(1);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("the close button dismisses it", async () => {
    const { createRecapCard, recapOf } = await import("../src/moments/recap");
    const card = createRecapCard();
    const d = recapOf(windows(), 600_000, ["Ada"]);
    if (d === null) throw new Error("no recap");
    card.show(d);
    card.root.querySelector<HTMLButtonElement>('[data-testid="recap-close"]')?.click();
    expect(card.root.hidden).toBe(true);
  });
});
