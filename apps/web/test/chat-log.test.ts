import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-594 (M7 W1, set k): the chat log. One capped list used by the room page, the full-screen strip (W2) and the
// pop-out (W3). DOM, text only. A message is one append (and, at the cap, one removal of the oldest), never a redraw.
// Lines age by tone (fresh → settled at 6 s → faded at 20 s, the last only where the log fades), one timer for the
// whole log, and nothing ages while the pointer or focus is in it.

type Ageing = "settle" | "fade";

async function setup(ageing: Ageing = "settle", cap?: number, frames: (() => void)[] = []) {
  const { createChatLog } = await import("../src/chat/log");
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextId = 1;
  const log = createChatLog({
    ageing,
    ...(cap === undefined ? {} : { cap }),
    requestFrame: (fn) => {
      frames.push(fn);
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (h) => {
      if (typeof h === "number") timers.delete(h);
    },
  });
  document.body.replaceChildren(log.root);
  /** Move the clock to `t`, firing due timers in order. */
  const advance = (t: number): void => {
    for (;;) {
      let due: [number, { fn: () => void; at: number }] | null = null;
      for (const e of timers) if (e[1].at <= t && (due === null || e[1].at < due[1].at)) due = e;
      if (due === null) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = t;
  };
  const lines = (): HTMLElement[] => [...log.root.querySelectorAll<HTMLElement>("[data-testid=chat-log-line]")];
  const chat = (nickname: string, text: string, self = false): void => {
    log.append({ kind: "chat", nickname, text, self });
  };
  return { log, lines, chat, advance, timers };
}

describe("chat log: structure and accessibility", () => {
  test("is a polite live log, keyboard-reachable, with a label", async () => {
    const { log, chat } = await setup();
    expect(log.root.getAttribute("role")).toBe("log");
    // role=log replaces a list's role, so its lines are not <li>s: a list item needs a list parent (axe `listitem`, OME-701).
    chat("Kit", "hi");
    expect(["OL", "UL"]).not.toContain(log.root.tagName);
    expect(log.root.querySelectorAll("li")).toHaveLength(0);
    expect(log.root.getAttribute("aria-live")).toBe("polite");
    expect(log.root.getAttribute("aria-label")).toBe("Chat messages");
    expect(log.root.tabIndex).toBe(0);
  });

  test("a chat line shows the name in bold and the text, as text only", async () => {
    const { lines, chat } = await setup();
    chat("<b>Kit</b>", "<img src=x onerror=alert(1)> hi");
    const [l] = lines();
    expect(l?.querySelector("b")?.textContent).toBe("<b>Kit</b>");
    expect(l?.textContent).toBe("<b>Kit</b> <img src=x onerror=alert(1)> hi");
    expect(l?.querySelector("img")).toBeNull();
    expect(l?.querySelectorAll("b").length).toBe(1);
  });

  test("my own lines are marked as mine", async () => {
    const { lines, chat } = await setup();
    chat("Ada", "mine", true);
    chat("Kit", "theirs");
    expect(lines().map((l) => l.classList.contains("self"))).toEqual([true, false]);
  });

  test("a line that mentions me wears the mention highlight (OME-1531)", async () => {
    const { log, lines } = await setup();
    log.append({ kind: "chat", nickname: "Kit", text: "hi @ada", self: false, mention: true });
    log.append({ kind: "chat", nickname: "Kit", text: "hi", self: false, mention: false });
    expect(lines().map((l) => l.classList.contains("is-mention"))).toEqual([true, false]);
  });

  test("a system line renders like the caption rail's (glyph, actor, verb, only-you bar)", async () => {
    const { log, lines } = await setup();
    log.append({ kind: "system", line: { glyph: "chat-mute", actor: "The host", verb: "muted your chat", time: null, self: true } });
    log.append({ kind: "system", line: { glyph: "seek", actor: "Ben", verb: "skipped to", time: "12:30" } });
    const [mute, seek] = lines();
    expect(mute?.textContent).toBe("The host muted your chat");
    expect(mute?.querySelector(".ui-sysline.self")).not.toBeNull();
    expect(seek?.querySelector("time")?.textContent).toBe("12:30");
    expect(seek?.querySelector(".ui-glyph-seek")).not.toBeNull();
  });
});

describe("chat log: /me action lines (OME-1375)", () => {
  test("a /me line reads as the speaker doing it, italic, the name still bold, text only", async () => {
    const { lines, chat } = await setup();
    chat("Sam", "/me waves at <b>the</b> screen");
    chat("Kit", "hi");
    const [action, plain] = lines();
    expect(action?.textContent).toBe("Sam waves at <b>the</b> screen");
    expect(action?.querySelector("b")?.textContent).toBe("Sam");
    expect(action?.querySelectorAll("b").length).toBe(1);
    expect(action?.classList.contains("is-action")).toBe(true);
    expect(plain?.classList.contains("is-action")).toBe(false);
  });
});

describe("chat log: /think thought lines (OME-1465)", () => {
  test("a /think line reads as the speaker thinking it, italic, the name still bold, text only", async () => {
    const { lines, chat } = await setup();
    chat("Sam", "/think is <b>this</b> live?");
    chat("Kit", "hi");
    const [thought, plain] = lines();
    expect(thought?.textContent).toBe("Sam thinks: is <b>this</b> live?");
    expect(thought?.querySelector("b")?.textContent).toBe("Sam");
    expect(thought?.querySelectorAll("b").length).toBe(1);
    expect(thought?.classList.contains("is-think")).toBe(true);
    expect(plain?.classList.contains("is-think")).toBe(false);
  });
});

describe("chat log: cap and one append per message", () => {
  test("keeps only the newest `cap` lines, oldest dropped first", async () => {
    const { lines, chat } = await setup("settle", 5);
    for (let i = 0; i < 12; i++) chat("Kit", `m${String(i)}`);
    expect(lines().map((l) => l.textContent)).toEqual(["Kit m7", "Kit m8", "Kit m9", "Kit m10", "Kit m11"]);
    expect(lines().length).toBe(5);
  });

  test("the default cap is 50", async () => {
    const { lines, chat } = await setup();
    for (let i = 0; i < 80; i++) chat("Kit", String(i));
    expect(lines().length).toBe(50);
    expect(lines()[0]?.textContent).toBe("Kit 30");
  });

  test("a message is one added node; at the cap, one added and one removed; the other nodes are kept", async () => {
    const { log, lines, chat } = await setup("settle", 3);
    chat("Kit", "a");
    chat("Kit", "b");
    const before = lines();
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(log.root, { childList: true, subtree: true, characterData: true });
    chat("Kit", "c");
    await Promise.resolve();
    const afterOne = records.splice(0);
    expect(afterOne.reduce((n, r) => n + r.addedNodes.length, 0)).toBe(1);
    expect(afterOne.reduce((n, r) => n + r.removedNodes.length, 0)).toBe(0);
    expect(afterOne.every((r) => r.target === log.root)).toBe(true);
    chat("Kit", "d");
    await Promise.resolve();
    const atCap = records.splice(0);
    mo.disconnect();
    expect(atCap.reduce((n, r) => n + r.addedNodes.length, 0)).toBe(1);
    expect(atCap.reduce((n, r) => n + r.removedNodes.length, 0)).toBe(1);
    expect(atCap.every((r) => r.target === log.root)).toBe(true);
    // b survived as the same node, not a re-created one.
    expect(lines()[0]).toBe(before[1]);
  });
});

describe("chat log: ageing by tone", () => {
  test("settle: fresh, then settled at 6 s, never faded", async () => {
    const { lines, chat, advance } = await setup("settle");
    chat("Kit", "hi");
    const [l] = lines();
    expect(l?.classList.contains("is-settled")).toBe(false);
    advance(5999);
    expect(l?.classList.contains("is-settled")).toBe(false);
    advance(6000);
    expect(l?.classList.contains("is-settled")).toBe(true);
    advance(60_000);
    expect(l?.classList.contains("is-faded")).toBe(false);
  });

  test("fade: settled at 6 s, faded at 20 s", async () => {
    const { lines, chat, advance } = await setup("fade");
    chat("Kit", "hi");
    advance(2000);
    chat("Kit", "later");
    const [a, b] = lines();
    advance(6000);
    expect(a?.classList.contains("is-settled")).toBe(true);
    expect(b?.classList.contains("is-settled")).toBe(false);
    advance(20_000);
    expect(a?.classList.contains("is-faded")).toBe(true);
    expect(b?.classList.contains("is-faded")).toBe(false);
    advance(22_000);
    expect(b?.classList.contains("is-faded")).toBe(true);
  });

  test("fade: a new line settles on time even while an older line's fade is the armed timer", async () => {
    const { lines, chat, advance } = await setup("fade");
    chat("Kit", "a");
    advance(10_000);
    chat("Kit", "b");
    advance(15_999);
    expect(lines()[1]?.classList.contains("is-settled")).toBe(false);
    advance(16_000);
    expect(lines()[1]?.classList.contains("is-settled")).toBe(true);
    expect(lines()[0]?.classList.contains("is-faded")).toBe(false);
    advance(20_000);
    expect(lines()[0]?.classList.contains("is-faded")).toBe(true);
  });

  test("one timer for the whole log, however many lines", async () => {
    const { chat, advance, timers } = await setup("fade");
    for (let i = 0; i < 30; i++) {
      chat("Kit", String(i));
      advance(i * 100);
    }
    expect(timers.size).toBe(1);
    advance(100_000);
    expect(timers.size).toBe(0);
  });

  test("nothing ages while the pointer or focus is in the log; the hold is added on when it leaves", async () => {
    const { log, lines, chat, advance } = await setup("settle");
    chat("Kit", "hi");
    advance(1000);
    log.root.dispatchEvent(new Event("pointerenter"));
    advance(30_000);
    const [l] = lines();
    expect(l?.classList.contains("is-settled")).toBe(false);
    log.root.dispatchEvent(new Event("pointerleave"));
    advance(34_999);
    expect(l?.classList.contains("is-settled")).toBe(false);
    advance(35_000);
    expect(l?.classList.contains("is-settled")).toBe(true);
  });

  test("focus inside holds too, until both focus and pointer are gone", async () => {
    const { log, lines, chat, advance } = await setup("settle");
    chat("Kit", "hi");
    log.root.dispatchEvent(new FocusEvent("focusin"));
    log.root.dispatchEvent(new Event("pointerenter"));
    log.root.dispatchEvent(new Event("pointerleave"));
    advance(10_000);
    expect(lines()[0]?.classList.contains("is-settled")).toBe(false);
    log.root.dispatchEvent(new FocusEvent("focusout"));
    advance(15_999);
    expect(lines()[0]?.classList.contains("is-settled")).toBe(false);
    advance(16_000);
    expect(lines()[0]?.classList.contains("is-settled")).toBe(true);
  });

  test("switching to fade (full-screen strip) fades lines already past 20 s; back to settle shows them settled", async () => {
    const { log, lines, chat, advance } = await setup("settle");
    chat("Kit", "old");
    advance(25_000);
    log.setAgeing("fade");
    advance(25_000);
    expect(lines()[0]?.classList.contains("is-faded")).toBe(true);
    expect(log.root.dataset["ageing"]).toBe("fade");
    log.setAgeing("settle");
    expect(lines()[0]?.classList.contains("is-faded")).toBe(false);
    expect(lines()[0]?.classList.contains("is-settled")).toBe(true);
  });
});

// OME-769 (M9 W3): "Hide for me" also takes down what a hidden member already said, and "Show" brings it back. One pass
// over at most `cap` lines when the hidden set changes, nothing per message.
describe("chat log: hide for me", () => {
  test("lines from a hidden member are hidden; system lines and everyone else's stay; show brings them back", async () => {
    const { log, lines } = await setup();
    log.append({ kind: "chat", nickname: "Bo", text: "boo", self: false }, "b");
    log.append({ kind: "chat", nickname: "Ada", text: "hi", self: false }, "a");
    log.append({ kind: "system", line: { glyph: "seek", actor: "Bo", verb: "skipped to", time: "1:00" } });
    log.hideFrom((id) => id === "b");
    expect(lines().map((l) => l.hidden)).toEqual([true, false, false]);
    log.hideFrom(() => false);
    expect(lines().map((l) => l.hidden)).toEqual([false, false, false]);
  });

  test("a line added later from a member hidden before is added hidden (a reconnect's backlog)", async () => {
    const { log, lines } = await setup();
    log.hideFrom((id) => id === "b");
    log.append({ kind: "chat", nickname: "Bo", text: "late", self: false }, "b");
    expect(lines().map((l) => l.hidden)).toEqual([true]);
  });
});

// OME-1755: at the rate limit several lines land in one frame. Reading scrollHeight per line forced a style and layout
// pass inside every socket message (62 % of the observer's message time in the wide chat burst). The log sticks to its
// foot once per frame instead, and a message never reads layout while the reader is at the foot.
describe("chat log: sticking to the foot (OME-1755)", () => {
  const measured = (root: HTMLElement, height: () => number): { reads: () => number } => {
    let reads = 0;
    Object.defineProperty(root, "scrollHeight", { configurable: true, get: () => { reads++; return height(); } });
    Object.defineProperty(root, "clientHeight", { configurable: true, get: () => 100 });
    return { reads: () => reads };
  };

  test("a burst of lines reads no layout per message and sticks to the foot once, in the next frame", async () => {
    const frames: (() => void)[] = [];
    const { log, chat } = await setup("settle", undefined, frames);
    const m = measured(log.root, () => 900);
    for (let i = 0; i < 5; i++) chat("Kit", String(i));
    expect(m.reads()).toBe(0);
    expect(frames.length).toBe(1);
    frames.shift()?.();
    expect(m.reads()).toBe(1);
    expect(log.root.scrollTop).toBe(900);
  });

  test("the scroll a new line causes before its frame doesn't stop the log following", async () => {
    const frames: (() => void)[] = [];
    const { log, chat } = await setup("settle", undefined, frames);
    let height = 900;
    const m = measured(log.root, () => height);
    chat("Kit", "a");
    // The line made the content taller; the browser fires scroll before the frame's callbacks run.
    height = 1000;
    log.root.dispatchEvent(new Event("scroll"));
    frames.shift()?.();
    const before = m.reads();
    chat("Kit", "b");
    expect(m.reads()).toBe(before);
    expect(frames.length).toBe(1);
  });

  // OME-1831: the window narrows, the chat column with it, the lines rewrap and the browser's scroll anchoring moves
  // scrollTop, all before the ResizeObserver's callback. That scroll is the layout's, not the reader's.
  test("a scroll at a new box size keeps a following log at its foot", async () => {
    const frames: (() => void)[] = [];
    const { log, chat } = await setup("settle", undefined, frames);
    let width = 300;
    let height = 900;
    Object.defineProperty(log.root, "clientWidth", { configurable: true, get: () => width });
    measured(log.root, () => height);
    log.root.scrollTop = 800;
    log.root.dispatchEvent(new Event("scroll"));
    width = 200;
    height = 1000;
    log.root.scrollTop = 850;
    log.root.dispatchEvent(new Event("scroll"));
    expect(log.root.scrollTop).toBe(1000);
    chat("Kit", "a");
    expect(frames.length).toBe(1);
  });

  test("a reader scrolled up stays put: no frame is asked for", async () => {
    const frames: (() => void)[] = [];
    const { log, chat } = await setup("settle", undefined, frames);
    measured(log.root, () => 900);
    log.root.scrollTop = 100;
    log.root.dispatchEvent(new Event("scroll"));
    chat("Kit", "a");
    expect(frames.length).toBe(0);
    expect(log.root.scrollTop).toBe(100);
  });
});
