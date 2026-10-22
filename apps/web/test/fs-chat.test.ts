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

/** The chat pinned shown: the hide-chat tests start from there; full screen's own default is hidden (OME-1668). */
const shown = () => memory({ "omega.fsChatHidden": "0" });

async function make(store = shown()) {
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
    const store = shown();
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

// OME-1668 (board OME-1664): full screen hides the chat by default; the pointer at the bottom edge, a tap there, Enter
// or Tab bring it back for a while ("peek"); focus in it or a draft holds it.
describe("the peek", () => {
  test("with nothing stored, full screen starts with the chat hidden; outside full screen nothing is hidden", async () => {
    const { chat, changes } = await make(memory());
    expect(chat.hidden()).toBe(false);
    chat.setActive(true);
    expect(chat.hidden()).toBe(true);
    expect(changes).toEqual([true]);
  });

  test("peek(true) shows it now; peek(false) hides it ~2 s later, and moving on doesn't put that off", async () => {
    const { chat, c, changes } = await make(memory());
    chat.setActive(true);
    chat.peek(true);
    expect(chat.hidden()).toBe(false);
    chat.peek(false);
    c.advance(1000);
    chat.peek(false);
    c.advance(999);
    expect(chat.hidden()).toBe(false);
    c.advance(1);
    expect(chat.hidden()).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });

  test("coming back before the countdown ends keeps it shown", async () => {
    const { chat, c } = await make(memory());
    chat.setActive(true);
    chat.peek(true);
    chat.peek(false);
    c.advance(1500);
    chat.peek(true);
    c.advance(5000);
    expect(chat.hidden()).toBe(false);
  });

  test("focus or a draft holds it past the countdown; letting go starts the countdown", async () => {
    const { chat, c } = await make(memory());
    chat.setActive(true);
    chat.hold(true);
    expect(chat.hidden()).toBe(false);
    chat.peek(false);
    c.advance(5000);
    expect(chat.hidden()).toBe(false);
    chat.hold(false);
    c.advance(1999);
    expect(chat.hidden()).toBe(false);
    c.advance(1);
    expect(chat.hidden()).toBe(true);
  });

  test("no peek outside full screen; leaving full screen ends one, so the next starts hidden", async () => {
    const { chat, changes } = await make(memory());
    chat.peek(true);
    expect(changes).toEqual([]);
    chat.setActive(true);
    chat.peek(true);
    chat.setActive(false);
    chat.setActive(true);
    expect(chat.hidden()).toBe(true);
  });

  test("the chat pinned shown ignores the peek; the handle pins it from a peek", async () => {
    const { chat, c } = await make();
    chat.setActive(true);
    chat.peek(true);
    chat.peek(false);
    c.advance(5000);
    expect(chat.hidden()).toBe(false);
    chat.setHidden(true);
    chat.peek(true);
    expect(chat.toggle.ariaLabel).toBe("Show chat");
    expect(chat.toggle.getAttribute("aria-expanded")).toBe("true");
    chat.toggle.click();
    chat.peek(false);
    c.advance(5000);
    expect(chat.hidden()).toBe(false);
  });
});

describe("fullscreenLayout with the chat hidden: really full screen (OME-1593), the largest centred 16:9 picture", () => {
  // Nothing of ours over the player (ADR 0012, YouTube's RMF): the show-chat handle keeps a 44 px margin on its edge and
  // the opposite one, so the picture stays centred; the bubbles get what the screen leaves, never the picture.
  test.each([
    // A 16:9 desktop: only the handle's margins; no room for bubbles.
    [1280, 720, { x: 44, y: 24, w: 1192, h: 671 }, { x: 1236, y: 0, w: 0, h: 720 }, { x: 1236, y: 338, w: 44, h: 44 }, "left"],
    // A phone held sideways: its letterbox already holds the handle, so nothing is reserved.
    [844, 390, { x: 82, y: 0, w: 679, h: 382 }, { x: 761, y: 0, w: 0, h: 390 }, { x: 800, y: 173, w: 44, h: 44 }, "left"],
    // Ultrawide: bubbles beside the picture, clear of the handle.
    [2560, 1080, { x: 327, y: 0, w: 1905, h: 1072 }, { x: 2232, y: 0, w: 284, h: 1080 }, { x: 2516, y: 518, w: 44, h: 44 }, "left"],
    // A phone in portrait: the picture centred, bubbles under it, the handle at the bottom edge.
    [390, 844, { x: 0, y: 312, w: 390, h: 219 }, { x: 0, y: 531, w: 390, h: 269 }, { x: 173, y: 800, w: 44, h: 44 }, "up"],
  ] as const)("%i×%i", (w, h, tv, strip, handle, arrow) => {
    const l = fullscreenLayout(w, h, "youtube", "hidden");
    // The screen's bottom rows stay ours (OME-1668), so a pointer pushed to the bottom edge reaches the page and shows the chat.
    expect(h - (l.tv.y + l.tv.h)).toBeGreaterThanOrEqual(8);
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
