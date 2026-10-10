import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-730 (M8 W1): a chat message floats over its speaker as a set (l) bubble. A fixed pool of 8 DOM nodes, reused
// oldest-first; overlap resolved once per frame that brings sizes and once per walk end, never per walk frame. Every box
// measures 100×30 here (the browser measures the real text, in the frame's own layout: OME-802).

const W = 100;
const H = 30;

interface Sized {
  readonly target: Element;
  readonly borderBoxSize: readonly { inlineSize: number; blockSize: number }[];
}

async function setup(o: { reduced?: boolean; nameW?: number } = {}) {
  const { createFloats, FLOAT_LIFE_MS, FLOAT_LEAVE_MS } = await import("../src/bubbles/floats");
  const layer = document.createElement("div");
  layer.setAttribute("aria-live", "polite");
  let now = 0;
  /** False while the stage is hidden (full screen, room popped out): nothing has a layout, every box reads 0×0. */
  let laidOut = true;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextHandle = 1;
  // The browser's ResizeObserver, by hand: `frame()` is one rendering update, delivering every watched box's size from
  // that frame's own layout (a box with no layout reports nothing, and keeps being watched).
  const watched = new Set<Element>();
  let observed = 0;
  let deliveries = 0;
  let onSizes: ((entries: readonly Sized[]) => void) | null = null;
  const floats = createFloats(layer, {
    reducedMotion: { matches: o.reduced ?? false },
    now: () => now,
    setTimer: (fn, ms) => {
      const h = nextHandle++;
      timers.set(h, { fn, at: now + ms });
      return h;
    },
    clearTimer: (h) => {
      if (typeof h === "number") timers.delete(h);
    },
    watch: (cb) => {
      onSizes = cb;
      return {
        observe: (e) => {
          observed++;
          watched.add(e);
        },
        unobserve: (e) => {
          watched.delete(e);
        },
      };
    },
  });
  // A box showing its speaker's name (a <b> that isn't hidden, or the twin's generated name) is that much wider.
  const sizeOf = (e: Element): number => {
    const who = e.querySelector<HTMLElement>("b");
    const named = (who !== null && !who.hidden) || e.querySelector("[data-who]") !== null;
    return W + (named ? (o.nameW ?? 0) : 0);
  };
  const frame = (): void => {
    if (!laidOut || watched.size === 0 || onSizes === null) return;
    deliveries++;
    onSizes([...watched].map((target) => ({ target, borderBoxSize: [{ inlineSize: sizeOf(target), blockSize: H }] })));
  };
  /** Move the clock on, firing due timers in order. */
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      let due: [number, { fn: () => void; at: number }] | undefined;
      for (const t of timers) if (t[1].at <= until && (due === undefined || t[1].at < due[1].at)) due = t;
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  const slots = () => [...layer.querySelectorAll<HTMLElement>(".float-slot")];
  const shown = () => slots().filter((s) => !s.hidden);
  const bubbleOf = (text: string): HTMLElement => {
    const say = [...layer.querySelectorAll<HTMLElement>(".say > span")].find((e) => e.textContent === text);
    const p = say?.closest<HTMLElement>(".ui-float");
    if (p === null || p === undefined) throw new Error(`no bubble "${text}"`);
    return p;
  };
  const texts = () => [...layer.querySelectorAll("[data-testid=chat-message]")].map((e) => e.textContent);
  const push = (text: string) => bubbleOf(text).style.getPropertyValue("--push");
  return {
    floats,
    layer,
    advance,
    frame,
    slots,
    shown,
    bubbleOf,
    texts,
    push,
    observed: () => observed,
    deliveries: () => deliveries,
    setLaidOut: (v: boolean) => (laidOut = v),
    FLOAT_LIFE_MS,
    FLOAT_LEAVE_MS,
    setNow: (t: number) => (now = t),
  };
}

const say = (id: string, text: string, x: number, y = 300, o: { self?: boolean; startedAt?: number } = {}) => ({
  id,
  name: `name-${id}`,
  text,
  self: o.self ?? false,
  at: { x, y },
  startedAt: o.startedAt ?? Number.NaN,
});

test("the layer is decorative: aria-hidden, no live region (the chat log reads the message)", async () => {
  const { layer } = await setup();
  expect(layer.getAttribute("aria-hidden")).toBe("true");
  expect(layer.hasAttribute("aria-live")).toBe(false);
});

test("a message fills one of 8 pool nodes; idle nodes are hidden and carry no chat-message", async () => {
  const { floats, slots, shown, texts } = await setup();
  expect(slots()).toHaveLength(8);
  expect(shown()).toHaveLength(0);
  expect(texts()).toEqual([]);
  floats.say(say("a", "hello <b>you</b>", 480));
  expect(shown()).toHaveLength(1);
  expect(texts()).toEqual(["hello <b>you</b>"]);
});

test("the outer node sits on the speaker's head, the inner box is centred over it with the tail tip 4 px below", async () => {
  const { floats, frame, shown, bubbleOf } = await setup();
  floats.say(say("a", "hi", 480, 300, { self: true }));
  frame();
  const slot = shown()[0];
  expect(slot?.style.transform).toBe("translate(480px, 300px)");
  const p = bubbleOf("hi");
  expect(p.style.left).toBe(`${String(-W / 2)}px`);
  expect(p.style.top).toBe(`${String(-(H + 4))}px`);
  expect(p.style.getPropertyValue("--tail-x")).toBe(`${String(W / 2)}px`);
  expect(p.classList.contains("is-self")).toBe(true);
  expect(p.classList.contains("is-live")).toBe(true);
  expect(p.classList.contains("tail-sw") || p.classList.contains("tail-se") || p.classList.contains("is-stacked")).toBe(false);
});

test("say() reads no layout: the size arrives with the frame's own layout, and only then do the keyframes start", async () => {
  // OME-802: an offsetWidth read in say() forced a whole-page style and layout per message, and one more per stacked
  // bubble, which doubled the main-thread work of a chat burst. Without .is-live until it is sized, a reused node's
  // keyframes start from the top in the same frame (the frame's style pass saw the node without them).
  const { floats, frame, bubbleOf, observed } = await setup();
  floats.say(say("a", "hi", 480));
  const p = bubbleOf("hi");
  expect(observed()).toBeGreaterThan(0);
  expect(p.classList.contains("is-live")).toBe(false);
  frame();
  expect(p.classList.contains("is-live")).toBe(true);
  expect(p.style.left).toBe(`${String(-W / 2)}px`);
});

test("by default the sizes come from a ResizeObserver: a burst, a walk end and a reflow read no layout at all", async () => {
  const { createFloats } = await import("../src/bubbles/floats");
  const reads: string[] = [];
  const restore: (() => void)[] = [];
  for (const k of ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight", "scrollWidth", "scrollHeight"] as const) {
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k) ?? Object.getOwnPropertyDescriptor(Element.prototype, k);
    if (d === undefined) continue;
    const owner = Object.prototype.hasOwnProperty.call(HTMLElement.prototype, k) ? HTMLElement.prototype : Element.prototype;
    Object.defineProperty(owner, k, {
      configurable: true,
      get() {
        reads.push(k);
        return 0;
      },
    });
    restore.push(() => Object.defineProperty(owner, k, d));
  }
  const rect = spyOn(Element.prototype, "getBoundingClientRect");
  const realRO = globalThis.ResizeObserver;
  const watched: Element[] = [];
  globalThis.ResizeObserver = class {
    observe(e: Element) {
      watched.push(e);
    }
    unobserve(e: Element) {
      watched.splice(watched.indexOf(e), 1);
    }
    disconnect() {
      watched.length = 0;
    }
  };
  try {
    const floats = createFloats(document.createElement("div"), { reducedMotion: { matches: false }, now: () => 0, setTimer: () => 0, clearTimer: () => undefined });
    for (let i = 0; i < 12; i++) floats.say(say(`m${String(i % 7)}`, `t${String(i)}`, 480));
    floats.settle("m1", 300, 300);
    floats.reflow();
    expect(reads).toEqual([]);
    expect(rect).not.toHaveBeenCalled();
    expect(watched.length).toBeGreaterThan(0);
  } finally {
    globalThis.ResizeObserver = realRO;
    rect.mockRestore();
    for (const r of restore) r();
  }
});

test("clamped at the stage edge the box stays inside and the tail leans to the speaker", async () => {
  const { floats, frame, bubbleOf } = await setup();
  floats.say(say("a", "left", 10, 300));
  floats.say(say("b", "right", 950, 500));
  frame();
  const l = bubbleOf("left");
  expect(l.style.left).toBe("-6px"); // box at stage x 4
  expect(l.style.getPropertyValue("--tail-x")).toBe("6px");
  expect(l.classList.contains("tail-sw")).toBe(true);
  const r = bubbleOf("right");
  expect(r.style.left).toBe("-94px"); // box at 960 - 4 - 100 = 856
  expect(r.style.getPropertyValue("--tail-x")).toBe("94px");
  expect(r.classList.contains("tail-se")).toBe(true);
});

test("a message lives FLOAT_LIFE_MS, then its node goes back to the pool", async () => {
  const { floats, frame, advance, shown, texts, FLOAT_LIFE_MS } = await setup();
  floats.say(say("a", "bye", 480));
  frame();
  advance(FLOAT_LIFE_MS - 1);
  expect(shown()).toHaveLength(1);
  advance(1);
  expect(shown()).toHaveLength(0);
  expect(texts()).toEqual([]);
});

test("a message adopted mid-life (pop-out) starts its animation part-way and leaves on time", async () => {
  const { floats, frame, advance, shown, bubbleOf, setNow, FLOAT_LIFE_MS } = await setup();
  setNow(10_000);
  floats.say(say("a", "late", 480, 300, { startedAt: 8_000 }));
  frame();
  expect(bubbleOf("late").style.animationDelay).toBe("-2000ms");
  advance(FLOAT_LIFE_MS - 2_000);
  expect(shown()).toHaveLength(0);
});

test("8 on screen at most: a ninth message reuses the oldest node, and no node is created or removed", async () => {
  const { floats, frame, slots, shown, texts } = await setup();
  const before = slots();
  for (let i = 0; i < 8; i++) floats.say(say(`m${String(i)}`, `t${String(i)}`, 60 + i * 110));
  frame();
  expect(shown()).toHaveLength(8);
  const oldest = before.find((s) => s.textContent.includes("t0"));
  floats.say(say("m9", "t9", 480));
  frame();
  expect(shown()).toHaveLength(8);
  expect(slots()).toEqual(before);
  expect(texts()).not.toContain("t0");
  expect(oldest?.textContent).toContain("t9");
});

test("2 per speaker: a third message sends their oldest away (a short fade), the others stay", async () => {
  const { floats, frame, advance, texts, bubbleOf, FLOAT_LEAVE_MS } = await setup();
  floats.say(say("a", "one", 200));
  floats.say(say("a", "two", 200));
  floats.say(say("b", "other", 700));
  frame();
  floats.say(say("a", "three", 200));
  expect(bubbleOf("one").classList.contains("is-leaving")).toBe(true);
  advance(FLOAT_LEAVE_MS);
  expect(texts().sort()).toEqual(["other", "three", "two"]);
});

test("reduced motion: an early exit is instant", async () => {
  const { floats, texts } = await setup({ reduced: true });
  floats.say(say("a", "one", 200));
  floats.say(say("a", "two", 200));
  floats.say(say("a", "three", 200));
  expect(texts().sort()).toEqual(["three", "two"]);
});

test("an older bubble in a newer one's way moves straight up, 3 px clear, loses its tail and names its speaker", async () => {
  const { floats, frame, bubbleOf, push } = await setup();
  floats.say(say("a", "older", 480));
  frame();
  floats.say(say("b", "newer", 500));
  frame();
  // Same height, same start: older bottom (296) + 3 must be at newer's top (266).
  expect(push("older")).toBe("-33px");
  expect(push("newer")).toBe("0px");
  const older = bubbleOf("older");
  expect(older.classList.contains("is-stacked")).toBe(true);
  expect(older.querySelector<HTMLElement>(".who")?.hidden).toBe(false);
  expect(older.querySelector(".who")?.textContent).toBe("name-a");
  expect(bubbleOf("newer").querySelector<HTMLElement>(".who")?.hidden).toBe(true);
});

test("the rise an older bubble already has counts: 1 s older is 4 px higher, so it moves 4 px less", async () => {
  const { floats, frame, advance, push } = await setup();
  floats.say(say("a", "older", 480));
  frame();
  advance(1000);
  floats.say(say("b", "newer", 500));
  frame();
  expect(push("older")).toBe("-29px");
});

test("reduced motion has no rise, so the push is the full overlap", async () => {
  const { floats, frame, advance, push } = await setup({ reduced: true });
  floats.say(say("a", "older", 480));
  frame();
  advance(1000);
  floats.say(say("b", "newer", 500));
  frame();
  expect(push("older")).toBe("-33px");
});

test("bubbles side by side don't move; a stack of three climbs in order, newest nearest the heads", async () => {
  const { floats, frame, push } = await setup();
  floats.say(say("a", "far-left", 100));
  floats.say(say("b", "far-right", 800));
  frame();
  expect(push("far-left")).toBe("0px");
  floats.say(say("c", "first", 480));
  floats.say(say("d", "second", 480));
  floats.say(say("e", "third", 480));
  frame();
  expect(push("third")).toBe("0px");
  expect(push("second")).toBe("-33px");
  expect(push("first")).toBe("-66px");
  expect(push("far-left")).toBe("0px");
});

test("a burst sized in one frame is placed and stacked in one pass: the name-widened size came with it, never measured again", async () => {
  // Each node has a stacked twin (the same box with the name, never painted), sized in the same frame: a bubble that
  // stacks takes its width from the twin, so a burst costs one size delivery and no re-measure (OME-791, OME-802).
  const { floats, frame, push, bubbleOf, observed, deliveries } = await setup({ nameW: 40 });
  floats.say(say("a", "a-old", 380));
  floats.say(say("b", "b-old", 500));
  floats.say(say("c", "newest", 440));
  const watchedPerBurst = observed();
  frame();
  expect(deliveries()).toBe(1);
  expect(push("newest")).toBe("0px");
  expect(bubbleOf("b-old").style.left).toBe("-70px");
  expect(bubbleOf("a-old").style.left).toBe("-70px");
  expect(push("a-old")).toBe("-66px");
  frame();
  expect(deliveries()).toBe(1);
  expect(observed()).toBe(watchedPerBurst);
});

test("a stacked bubble is measured with its speaker's name shown: centred on the wider box, and neighbours on one row clear it", async () => {
  // OME-791: the name widens the box by 40 px. Measured before the name showed, a and b stayed 100 wide and centred on
  // that, so on the same row they overlapped by 20 px.
  const { floats, frame, bubbleOf, push } = await setup({ nameW: 40 });
  floats.say(say("a", "a-old", 380));
  frame();
  floats.say(say("b", "b-old", 500));
  frame();
  floats.say(say("c", "newest", 440));
  frame();
  expect(push("newest")).toBe("0px");
  expect(push("b-old")).toBe("-33px");
  expect(bubbleOf("b-old").style.left).toBe("-70px");
  expect(bubbleOf("a-old").style.left).toBe("-70px");
  expect(push("a-old")).toBe("-66px");
});

test("walking moves the speaker's bubbles only; overlap is resolved when the walk ends, never per frame", async () => {
  const { floats, frame, shown, push, observed } = await setup();
  floats.say(say("a", "older", 200));
  floats.say(say("b", "newer", 600));
  frame();
  const m = observed();
  for (let x = 600; x >= 210; x -= 2) floats.move("b", x, 300);
  expect(shown().find((s) => s.textContent.includes("newer"))?.style.transform).toBe("translate(210px, 300px)");
  expect(push("older")).toBe("0px");
  floats.settle("b", 210, 300);
  expect(push("older")).toBe("-33px");
  // "older" stacks with the size its twin already had: nothing is measured on the walk or at its end.
  expect(observed()).toBe(m);
});

test("keep: a speaker who left takes their bubbles along", async () => {
  const { floats, texts } = await setup();
  floats.say(say("a", "mine", 200));
  floats.say(say("b", "theirs", 700));
  floats.keep(new Map([["a", null]]));
  expect(texts()).toEqual(["mine"]);
});

test("said while the stage is hidden: placed and stacked once it shows again, the animation caught up to its age", async () => {
  const { floats, frame, advance, bubbleOf, push, setLaidOut } = await setup();
  floats.say(say("a", "before", 480));
  frame();
  setLaidOut(false);
  floats.reflow(); // hidden: nothing to measure
  advance(1000);
  floats.say(say("b", "hidden", 500));
  frame();
  advance(500);
  expect(bubbleOf("hidden").classList.contains("is-live")).toBe(false);
  setLaidOut(true);
  floats.reflow();
  frame();
  const p = bubbleOf("hidden");
  expect(p.style.left).toBe(`${String(-W / 2)}px`);
  expect(p.style.top).toBe(`${String(-(H + 4))}px`);
  expect(p.classList.contains("tail-sw") || p.classList.contains("tail-se")).toBe(false);
  // A hidden subtree drops its CSS animations; shown again they restart, so each is put back at its age.
  expect(p.style.animationDelay).toBe("-500ms");
  expect(bubbleOf("before").style.animationDelay).toBe("-1500ms");
  expect(push("before")).toBe("-29px");
});

test("an adopted bubble sent away still fades: the leave animation doesn't inherit its head start", async () => {
  const { floats, frame, bubbleOf, setNow } = await setup();
  setNow(10_000);
  floats.say(say("a", "one", 200, 300, { startedAt: 8_000 }));
  frame();
  floats.say(say("a", "two", 200));
  floats.say(say("a", "three", 200));
  const one = bubbleOf("one");
  expect(one.classList.contains("is-leaving")).toBe(true);
  expect(one.style.animationDelay).toBe("-2000ms, 0s");
});
