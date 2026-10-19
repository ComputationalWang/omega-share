import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fullscreenLayout } from "../src/layout";

// OME-1491 (board OME-1488): full screen's "hide chat". The strip and the shelf go, the picture takes the wrapper, and
// others' lines show as small bubbles over the picture's bottom-right corner: at most 4, oldest out first, ~6 s each.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

interface Timer { fn: () => void; at: number; live: boolean }

function clock() {
  let now = 0;
  const timers: Timer[] = [];
  return {
    setTimer: (fn: () => void, ms: number): Timer => {
      const t = { fn, at: now + ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t: Timer): void => {
      t.live = false;
    },
    advance(ms: number): void {
      now += ms;
      for (const t of [...timers]) {
        if (t.live && t.at <= now) {
          t.live = false;
          t.fn();
        }
      }
    },
  };
}

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}

async function make(store = memory()) {
  const { createFsChat } = await import("../src/fs-chat");
  const c = clock();
  const changes: boolean[] = [];
  const chat = createFsChat({ store, setTimer: c.setTimer, clearTimer: c.clearTimer, onChange: (h) => { changes.push(h); } });
  return { chat, c, changes, store };
}

const texts = (region: HTMLElement): string[] => [...region.children].map((b) => b.querySelector(".fs-bubble-text")?.textContent ?? "");

describe("the bubble queue", () => {
  test("a line shows as a bubble with the speaker's head, nickname and text, as text, never as HTML", async () => {
    const { chat } = await make();
    chat.setActive(true);
    chat.setHidden(true);
    chat.say(2, "Mo", "<img src=x onerror=alert(1)> hi");
    const b = chat.bubbles.firstElementChild;
    expect(b?.querySelector(".fs-bubble-head")?.classList.contains("a2")).toBe(true);
    expect(b?.querySelector(".fs-bubble-name")?.textContent).toBe("Mo");
    expect(b?.querySelector(".fs-bubble-text")?.textContent).toBe("<img src=x onerror=alert(1)> hi");
    expect(chat.bubbles.querySelector("img")).toBeNull();
  });

  test("at most 4 on screen: a fifth takes the oldest's place; newest last (the stack grows upward)", async () => {
    const { chat } = await make();
    chat.setActive(true);
    chat.setHidden(true);
    for (const t of ["1", "2", "3", "4", "5"]) chat.say(0, "Juno", t);
    expect(texts(chat.bubbles)).toEqual(["2", "3", "4", "5"]);
  });

  test("each bubble is gone ~6 s after it came, oldest first", async () => {
    const { chat, c } = await make();
    chat.setActive(true);
    chat.setHidden(true);
    chat.say(0, "Juno", "a");
    c.advance(2000);
    chat.say(1, "Pip", "b");
    c.advance(3999);
    expect(texts(chat.bubbles)).toEqual(["a", "b"]);
    c.advance(1);
    expect(texts(chat.bubbles)).toEqual(["b"]);
    c.advance(2000);
    expect(texts(chat.bubbles)).toEqual([]);
  });

  test("a bubble dropped by the cap doesn't take a later one down with its timer", async () => {
    const { chat, c } = await make();
    chat.setActive(true);
    chat.setHidden(true);
    for (const t of ["1", "2", "3", "4", "5"]) chat.say(0, "Juno", t);
    c.advance(5999);
    expect(texts(chat.bubbles)).toEqual(["2", "3", "4", "5"]);
    c.advance(1);
    expect(texts(chat.bubbles)).toEqual([]);
  });

  test("no bubbles unless full screen hides the chat; showing the chat or leaving full screen clears them", async () => {
    const { chat } = await make();
    chat.say(0, "Juno", "off");
    chat.setActive(true);
    chat.say(0, "Juno", "chat shown");
    expect(texts(chat.bubbles)).toEqual([]);
    chat.setHidden(true);
    chat.say(0, "Juno", "x");
    chat.setHidden(false);
    expect(texts(chat.bubbles)).toEqual([]);
    chat.setHidden(true);
    chat.say(0, "Juno", "y");
    chat.setActive(false);
    expect(texts(chat.bubbles)).toEqual([]);
  });

  test("the region is polite and never takes the pointer", async () => {
    const { chat } = await make();
    expect(chat.bubbles.getAttribute("aria-live")).toBe("polite");
    expect(chat.bubbles.classList.contains("fs-bubbles")).toBe(true);
  });
});

describe("the hide-chat toggle", () => {
  test("named, pressed state follows; remembered per viewer", async () => {
    const store = memory();
    const { chat, changes } = await make(store);
    expect(chat.toggle.ariaLabel).toBe("Hide chat");
    expect(chat.toggle.getAttribute("aria-pressed")).toBe("false");
    expect(chat.toggle.getAttribute("aria-keyshortcuts")).toBe("C");
    chat.setActive(true);
    chat.toggle.click();
    expect(chat.hidden()).toBe(true);
    expect(chat.toggle.getAttribute("aria-pressed")).toBe("true");
    expect(changes).toEqual([true]);
    expect(store.data.get("omega.fsChatHidden")).toBe("1");
    const again = await make(store);
    expect(again.chat.hidden()).toBe(false);
    again.chat.setActive(true);
    expect(again.chat.hidden()).toBe(true);
  });

  test("hidden only counts in full screen: leaving restores the layout but keeps the choice", async () => {
    const { chat, changes, store } = await make();
    chat.setActive(true);
    chat.setHidden(true);
    chat.setActive(false);
    expect(chat.hidden()).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(store.data.get("omega.fsChatHidden")).toBe("1");
  });

  test("C toggles in full screen when not typing; held repeats are swallowed; outside full screen it's not ours", async () => {
    const { chat } = await make();
    expect(chat.key("c", false)).toBe(false);
    chat.setActive(true);
    expect(chat.key("c", true)).toBe(false);
    expect(chat.key("C", false)).toBe(true);
    expect(chat.hidden()).toBe(true);
    expect(chat.key("c", false, true)).toBe(true);
    expect(chat.hidden()).toBe(true);
    expect(chat.key("c", false)).toBe(true);
    expect(chat.hidden()).toBe(false);
  });

  test("the pill says so and dims after ~3 s; a pointer move wakes it", async () => {
    const { chat, c } = await make();
    chat.setActive(true);
    chat.setHidden(true);
    expect(chat.toggle.textContent).toBe("Chat hidden · C");
    expect(chat.pill.classList.contains("is-idle")).toBe(false);
    c.advance(3000);
    expect(chat.pill.classList.contains("is-idle")).toBe(true);
    chat.wake();
    expect(chat.pill.classList.contains("is-idle")).toBe(false);
    c.advance(3000);
    expect(chat.pill.classList.contains("is-idle")).toBe(true);
  });
});

describe("fullscreenLayout with the chat hidden: the picture is as big as it gets beside a bubble column, nothing under it", () => {
  // YouTube's Required Minimum Functionality (ADR 0012): nothing of ours over any part of the player, so the bubbles get a
  // column of their own at the right (the strip's box), never the picture's corner.
  test.each([
    [1280, 720, { x: 0, y: 62, w: 1060, h: 596 }, { x: 1060, y: 0, w: 220, h: 720 }],
    [844, 390, { x: 0, y: 2, w: 684, h: 385 }, { x: 684, y: 0, w: 160, h: 390 }],
    [1280, 1024, { x: 0, y: 214, w: 1060, h: 596 }, { x: 1060, y: 0, w: 220, h: 1024 }],
    [2560, 1080, { x: 210, y: 0, w: 1920, h: 1080 }, { x: 2130, y: 0, w: 430, h: 1080 }],
  ])("%i×%i", (w, h, tv, strip) => {
    const l = fullscreenLayout(w, h, "youtube", "hidden");
    expect(l.at).toBe("hidden");
    expect(l.tv).toEqual(tv);
    expect(l.strip).toEqual(strip);
    expect(l.controls).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
