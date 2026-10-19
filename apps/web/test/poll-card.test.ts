import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PollView } from "../src/chat/poll";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-1454: the poll card. DOM only: options are real buttons (aria-pressed), counts and bars follow the counts, one
// 1 s interval drives the countdown and is cleared when the card goes.

const VIEW: PollView = { pollId: "p1", question: "Next video?", options: ["A", "B", "C"], counts: [3, 1, 0], vote: null, canClose: false, endsAt: 61_000 };

async function setup() {
  const { createPollCard } = await import("../src/chat/poll");
  let now = 1000;
  const votes: number[] = [];
  let closes = 0;
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const card = createPollCard({
    now: () => now,
    setInterval: (fn, ms) => {
      intervals.set(next, { fn, ms });
      return next++;
    },
    clearTimer: (h) => {
      intervals.delete(h);
    },
    vote: (o) => votes.push(o),
    close: () => closes++,
  });
  const tick = (ms: number): void => {
    now += ms;
    for (const t of intervals.values()) t.fn();
  };
  const buttons = (): HTMLButtonElement[] => [...card.root.querySelectorAll("button.poll-option")].filter((b): b is HTMLButtonElement => b instanceof HTMLButtonElement);
  return { card, votes, closes: () => closes, intervals, tick, buttons };
}

describe("poll card", () => {
  test("hidden until shown; shows the question, each option with its count, and the seconds left", async () => {
    const { card, buttons } = await setup();
    expect(card.root.hidden).toBe(true);
    card.show(VIEW);
    expect(card.root.hidden).toBe(false);
    expect(card.root.textContent).toContain("Next video?");
    expect(buttons().map((b) => b.textContent)).toEqual(["A3", "B1", "C0"]);
    expect(card.root.textContent).toContain("60s");
  });

  test("options are buttons; mine is aria-pressed; pressing one votes for it", async () => {
    const { card, buttons, votes } = await setup();
    card.show({ ...VIEW, vote: 1 });
    expect(buttons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    buttons()[2]?.click();
    expect(votes).toEqual([2]);
  });

  test("new counts update the same buttons in place (focus survives) and size the bars by share", async () => {
    const { card, buttons } = await setup();
    card.show(VIEW);
    const first = buttons()[0];
    card.show({ ...VIEW, counts: [1, 1, 2] });
    expect(buttons()[0]).toBe(first);
    expect(buttons().map((b) => b.textContent)).toEqual(["A1", "B1", "C2"]);
    expect(buttons().map((b) => b.querySelector<HTMLElement>(".poll-bar")?.style.width)).toEqual(["25%", "25%", "50%"]);
  });

  test("Close is there only for the opener or the owner, and asks to close", async () => {
    const { card, closes } = await setup();
    card.show(VIEW);
    const close = (): HTMLButtonElement | null => card.root.querySelector("button.poll-close");
    expect(close()?.hidden ?? true).toBe(true);
    card.show({ ...VIEW, canClose: true });
    close()?.click();
    expect(closes()).toBe(1);
  });

  test("the countdown ticks on one interval of 1 s, never goes below 0, and the interval is cleared when the card goes", async () => {
    const { card, intervals, tick } = await setup();
    card.show(VIEW);
    card.show({ ...VIEW, counts: [1, 0, 0] });
    expect([...intervals.values()].map((i) => i.ms)).toEqual([1000]);
    tick(1000);
    expect(card.root.textContent).toContain("59s");
    tick(100_000);
    expect(card.root.textContent).toContain("0s");
    card.hide();
    expect(intervals.size).toBe(0);
    expect(card.root.hidden).toBe(true);
  });

  test("a different poll rebuilds the options", async () => {
    const { card, buttons } = await setup();
    card.show(VIEW);
    card.show({ ...VIEW, pollId: "p2", question: "Pizza?", options: ["Yes", "No"], counts: [0, 0] });
    expect(buttons().map((b) => b.textContent)).toEqual(["Yes0", "No0"]);
  });
});
