import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fullscreenLayout } from "../src/layout";

// OME-1491 (board OME-1488): full screen's "hide chat". The strip and the shelf go, the picture takes the wrapper, and
// others' lines show as small bubbles in a column beside the picture: at most 4, oldest out first, ~6 s each.

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
  test("named for its action, expanded state follows (OME-1593); remembered per viewer", async () => {
    const store = memory();
    const { chat, changes } = await make(store);
    expect(chat.toggle.ariaLabel).toBe("Hide chat");
    expect(chat.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(chat.toggle.hasAttribute("aria-pressed")).toBe(false);
    expect(chat.toggle.getAttribute("aria-keyshortcuts")).toBe("C");
    chat.setActive(true);
    chat.toggle.click();
    expect(chat.hidden()).toBe(true);
    expect(chat.toggle.ariaLabel).toBe("Show chat");
    expect(chat.toggle.getAttribute("aria-expanded")).toBe("false");
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

  test("the handle dims after ~3 s while the chat is hidden; a pointer move wakes it", async () => {
    const { chat, c } = await make();
    chat.setActive(true);
    chat.setHidden(true);
    expect(chat.pill.classList.contains("is-idle")).toBe(false);
    c.advance(3000);
    expect(chat.pill.classList.contains("is-idle")).toBe(true);
    chat.wake();
    expect(chat.pill.classList.contains("is-idle")).toBe(false);
    c.advance(3000);
    expect(chat.pill.classList.contains("is-idle")).toBe(true);
  });
});

describe("fullscreenLayout with the chat hidden: really full screen (OME-1593), the largest centred 16:9 picture", () => {
  // Nothing of ours over the player (ADR 0012, YouTube's RMF): the show-chat handle keeps a 44 px margin on its edge and
  // the opposite one, so the picture stays centred; the bubbles get what the screen leaves, never the picture.
  test.each([
    // A 16:9 desktop: only the handle's margins; no room for bubbles.
    [1280, 720, { x: 44, y: 24, w: 1192, h: 671 }, { x: 1236, y: 0, w: 0, h: 720 }, { x: 1236, y: 338, w: 44, h: 44 }, "left"],
    // A phone held sideways: its letterbox already holds the handle, so nothing is reserved.
    [844, 390, { x: 75, y: 0, w: 693, h: 390 }, { x: 768, y: 0, w: 0, h: 390 }, { x: 800, y: 173, w: 44, h: 44 }, "left"],
    // Ultrawide: bubbles beside the picture, clear of the handle.
    [2560, 1080, { x: 320, y: 0, w: 1920, h: 1080 }, { x: 2240, y: 0, w: 276, h: 1080 }, { x: 2516, y: 518, w: 44, h: 44 }, "left"],
    // A phone in portrait: the picture centred, bubbles under it, the handle at the bottom edge.
    [390, 844, { x: 0, y: 312, w: 390, h: 219 }, { x: 0, y: 531, w: 390, h: 269 }, { x: 173, y: 800, w: 44, h: 44 }, "up"],
  ] as const)("%i×%i", (w, h, tv, strip, handle, arrow) => {
    const l = fullscreenLayout(w, h, "youtube", "hidden");
    expect(l.at).toBe("hidden");
    expect(l.tv).toEqual(tv);
    expect(l.strip).toEqual(strip);
    expect(l.controls).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(l.handle).toEqual({ ...handle, arrow });
  });
});

describe("fullscreenLayout's chat handle (OME-1593): centred on the open strip's edge, pointing where the chat goes", () => {
  test.each([
    [844, 390, "side", { x: 636, y: 173, w: 44, h: 44 }, "right"],
    [1280, 720, "side", { x: 980, y: 338, w: 44, h: 44 }, "right"],
    [390, 844, "below", { x: 173, y: 279, w: 44, h: 44 }, "down"],
  ] as const)("%i×%i", (w, h, at, handle, arrow) => {
    const l = fullscreenLayout(w, h, "youtube", "open");
    expect(l.at).toBe(at);
    expect(l.handle).toEqual({ ...handle, arrow });
    // Inside the strip, so never over the picture or the shelf.
    expect(handle.x).toBeGreaterThanOrEqual(l.strip.x);
    expect(handle.y).toBeGreaterThanOrEqual(l.strip.y);
  });

  test("no handle where the room is popped out", () => {
    expect(fullscreenLayout(1280, 720, "youtube", "none").handle).toBeUndefined();
  });
});
