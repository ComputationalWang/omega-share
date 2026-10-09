import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-415: under prefers-reduced-motion an emote is a static badge (set (i)'s picker icon) over the avatar for as long
// as the animation would have played. One per member; it rides along with a walker.

async function setup() {
  const { createEmoteBadges, BADGE_MS } = await import("../src/emote/badges");
  const layer = document.createElement("div");
  const timers: { fn: () => void; ms: number; h: number }[] = [];
  const cleared: number[] = [];
  const badges = createEmoteBadges(layer, {
    setTimer: (fn, ms) => {
      const h = timers.length + 1;
      timers.push({ fn, ms, h });
      return h;
    },
    clearTimer: (h) => {
      if (typeof h === "number") cleared.push(h);
    },
  });
  return { badges, layer, timers, cleared, BADGE_MS };
}

test("shows the kind's static icon at the avatar, then removes it after BADGE_MS", async () => {
  const { badges, layer, timers, BADGE_MS } = await setup();
  badges.show("m1", "heart", { x: 100, y: 200 });
  const b = layer.querySelector("[data-testid=emote-badge]");
  if (!(b instanceof HTMLElement)) throw new Error("no badge");
  expect(b.classList.contains("ui-emote-pick-heart")).toBe(true);
  expect(b.dataset["member"]).toBe("m1");
  expect(b.style.transform).toContain("translate(100px");
  expect(timers.at(-1)?.ms).toBe(BADGE_MS);
  timers.at(-1)?.fn();
  expect(layer.children.length).toBe(0);
});

test("a second emote replaces the member's badge and restarts its time", async () => {
  const { badges, layer, timers, cleared } = await setup();
  badges.show("m1", "heart", { x: 0, y: 0 });
  badges.show("m1", "wave", { x: 0, y: 0 });
  expect(layer.children.length).toBe(1);
  expect(layer.firstElementChild?.classList.contains("ui-emote-pick-wave")).toBe(true);
  expect(layer.firstElementChild?.classList.contains("ui-emote-pick-heart")).toBe(false);
  expect(cleared).toEqual([timers[0]?.h ?? -1]);
});

test("follows a walker, and goes when its member leaves", async () => {
  const { badges, layer } = await setup();
  badges.show("m1", "clap", { x: 0, y: 0 });
  badges.move("m1", 40, 60);
  expect((layer.firstElementChild as HTMLElement).style.transform).toContain("translate(40px");
  badges.move("m2", 1, 1);
  badges.keep(new Set(["m2"]));
  expect(layer.children.length).toBe(0);
});
