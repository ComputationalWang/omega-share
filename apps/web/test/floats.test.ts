import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
// measures 100×30 here (the browser measures the real text, in the frame's own layout: OME-802). No CSS animation: the
// rise and the fades are written on one shared step clock, 24 steps a life (OME-802).

const STEP = 5000 / 24;

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
  /**
   * The bare wrapper between the slot and the bubble carries all its motion (the push, the rise, the fade): restyling it
   * is cheap, where the bubble's own rules (border image, tail, custom properties) made every step a heavy style pass.
   */
  const motionOf = (text: string): HTMLElement => {
    const m = bubbleOf(text).parentElement;
    if (!m?.classList.contains("float-motion")) throw new Error(`"${text}" has no motion wrapper`);
    return m;
  };
  /** The push, as a length: the wrapper's `translateY(-Npx)`, "0px" when none. */
  const push = (text: string): string => {
    const t = motionOf(text).style.transform;
    return t === "" ? "0px" : t.replace(/^translateY\((.*)\)$/, "$1");
  };
  return {
    floats,
    layer,
    advance,
    frame,
    slots,
    shown,
    bubbleOf,
    motionOf,
    texts,
    push,
    observed: () => observed,
    /** Timers waiting: the step clock is one, and none once the layer is empty. */
    pending: () => timers.size,
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

test("a message fills one of 16 pool nodes; idle nodes are hidden and carry no chat-message", async () => {
  const { floats, slots, shown, texts } = await setup();
  expect(slots()).toHaveLength(16);
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

test("say() reads no layout: the size arrives with the frame's own layout, and only then is the bubble placed and live", async () => {
  // OME-802: an offsetWidth read in say() forced a whole-page style and layout per message, and one more per stacked
  // bubble, which doubled the main-thread work of a chat burst.
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
    const floats = createFloats(document.createElement("div"), { reducedMotion: { matches: false }, now: () => 0, setTimer: () => 0 });
    for (let i = 0; i < 12; i++) floats.say(say(`m${String(i % 7)}`, `t${String(i)}`, 480));
    floats.settle("m1", 300, 300);
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

test("a message adopted mid-life (pop-out) shows its rise so far and leaves on time, at the clock's next step", async () => {
  const { floats, frame, advance, shown, motionOf, setNow, FLOAT_LIFE_MS } = await setup();
  setNow(10_000);
  floats.say(say("a", "late", 480, 300, { startedAt: 8_000 }));
  frame();
  // 2 s old at the clock's step at 10 000 ms: 9 whole steps up.
  expect(motionOf("late").style.translate).toBe("0 -9px");
  advance(FLOAT_LIFE_MS - 2_000);
  expect(shown()).toHaveLength(1);
  advance(STEP);
  expect(shown()).toHaveLength(0);
});

test("one shared step clock: eight bubbles keep one timer between them, and it stops once the layer is empty", async () => {
  const { floats, frame, advance, shown, pending, FLOAT_LIFE_MS } = await setup();
  expect(pending()).toBe(0);
  for (let i = 0; i < 8; i++) {
    floats.say(say(`m${String(i)}`, `t${String(i)}`, 60 + i * 110));
    frame();
    advance(130);
  }
  expect(shown()).toHaveLength(8);
  expect(pending()).toBe(1);
  advance(FLOAT_LIFE_MS + STEP);
  expect(shown()).toHaveLength(0);
  expect(pending()).toBe(0);
});

test("the rise is 24 whole-pixel steps over the life, written on the clock's steps (no CSS animation)", async () => {
  const { floats, frame, advance, bubbleOf, motionOf } = await setup();
  floats.say(say("a", "up", 480));
  frame();
  const p = motionOf("up");
  // The bubble itself is never restyled by a step.
  expect(bubbleOf("up").style.translate).toBe("");
  expect(p.style.translate).toBe("");
  advance(1000); // the last step was at 834 ms: 4 steps
  expect(p.style.translate).toBe("0 -4px");
  advance(3999);
  expect(p.style.translate).toBe("0 -23px");
  expect(bubbleOf("up").style.translate).toBe("");
  expect(bubbleOf("up").style.opacity).toBe("");
});

test("shown whole at once, then faded out over the last 28 % of its life on the clock's steps", async () => {
  const { floats, frame, advance, motionOf } = await setup();
  floats.say(say("a", "fade", 480));
  frame();
  const p = motionOf("fade");
  expect(p.style.opacity).toBe("");
  advance(3500);
  expect(p.style.opacity).toBe("");
  advance(1000);
  const mid = Number(p.style.opacity);
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(1);
  advance(400);
  expect(Number(p.style.opacity)).toBeLessThan(mid);
});

test("reduced motion: no rise; opaque until 80 % of its life, then a linear fade", async () => {
  const { floats, frame, advance, motionOf } = await setup({ reduced: true });
  floats.say(say("a", "still", 480));
  frame();
  const p = motionOf("still");
  advance(3999);
  expect(p.style.translate).toBe("");
  expect(p.style.opacity).toBe("");
  advance(600);
  expect(p.style.translate).toBe("");
  const o = Number(p.style.opacity);
  expect(o).toBeGreaterThan(0);
  expect(o).toBeLessThan(1);
});

test("16 on screen at most: a 17th message reuses the oldest node, and no node is created or removed", async () => {
  const { floats, frame, slots, shown, texts } = await setup();
  const before = slots();
  for (let i = 0; i < 16; i++) floats.say(say(`m${String(i)}`, `t${String(i)}`, 60 + (i % 8) * 110, 400 + 100 * Math.floor(i / 8)));
  frame();
  expect(shown()).toHaveLength(16);
  const oldest = before.find((s) => s.textContent.includes("t0"));
  floats.say(say("m16", "t16", 480));
  frame();
  expect(shown()).toHaveLength(16);
  expect(slots()).toEqual(before);
  expect(texts()).not.toContain("t0");
  expect(oldest?.textContent).toContain("t16");
});

/** `n` lines from one speaker, "l0" oldest. */
const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `l${String(i)}`);

test("10 per speaker (OME-1050): an 11th message sends their oldest away (a short fade), the others stay", async () => {
  const { floats, frame, advance, texts, bubbleOf, FLOAT_LEAVE_MS } = await setup();
  for (const t of lines(10)) floats.say(say("a", t, 200, 580));
  floats.say(say("b", "other", 700));
  frame();
  expect(texts()).toHaveLength(11);
  floats.say(say("a", "l10", 200, 580));
  expect(bubbleOf("l0").classList.contains("is-leaving")).toBe(true);
  advance(FLOAT_LEAVE_MS);
  expect(texts().sort()).toEqual([...lines(11).slice(1), "other"].sort());
});

test("a bubble sent away before its size arrived goes at once: never painted unplaced, nothing to fade", async () => {
  // A join-time replay or a burst can bring a speaker's 11th line in the same task as their first.
  const { floats, frame, shown, texts } = await setup();
  for (const t of lines(11)) floats.say(say("a", t, 200, 580));
  expect(shown()).toHaveLength(10);
  frame();
  expect(texts().sort()).toEqual(lines(11).slice(1).sort());
});

test("reduced motion: an early exit is instant", async () => {
  const { floats, texts } = await setup({ reduced: true });
  for (const t of lines(11)) floats.say(say("a", t, 200, 580));
  expect(texts().sort()).toEqual(lines(11).slice(1).sort());
});

// OME-1050: ten stacked bubbles are 330 px; over a back-row head they would climb out of the room's view (ROOM_VIEW,
// the part of the stage the page shows, from y 60) and be clipped.
test("a stack never climbs out of the room's view: an older bubble whose rise would cross its top goes instead", async () => {
  const { floats, frame, texts, bubbleOf } = await setup();
  // Head at 300: the newest box's top is 266 and each older one 33 px higher; with the 24 px rise, l0 to l3 cross 60.
  for (const t of lines(10)) floats.say(say("a", t, 480, 300));
  frame();
  expect(bubbleOf("l0").classList.contains("is-leaving")).toBe(true);
  expect(bubbleOf("l3").classList.contains("is-leaving")).toBe(true);
  expect(texts().sort()).toEqual(lines(10).slice(4).sort());
});

test("reduced motion has no rise: only a box that would itself cross the top goes", async () => {
  const { floats, frame, texts } = await setup({ reduced: true });
  for (const t of lines(10)) floats.say(say("a", t, 480, 300));
  frame();
  expect(texts().sort()).toEqual(lines(10).slice(3).sort());
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

test("said while the stage is hidden: placed, stacked and shown at its age once it shows again", async () => {
  const { floats, frame, advance, bubbleOf, motionOf, push, setLaidOut } = await setup();
  floats.say(say("a", "before", 480));
  frame();
  setLaidOut(false);
  advance(1000);
  floats.say(say("b", "hidden", 500));
  frame(); // hidden: nothing to measure
  advance(500);
  expect(bubbleOf("hidden").classList.contains("is-live")).toBe(false);
  setLaidOut(true);
  frame();
  const p = bubbleOf("hidden");
  expect(p.style.left).toBe(`${String(-W / 2)}px`);
  expect(p.style.top).toBe(`${String(-(H + 4))}px`);
  expect(p.classList.contains("tail-sw") || p.classList.contains("tail-se")).toBe(false);
  // Both show their rise at the clock's last step (1458 ms): no animation to restart.
  expect(motionOf("hidden").style.translate).toBe("0 -2px");
  expect(motionOf("before").style.translate).toBe("0 -7px");
  expect(push("before")).toBe("-29px");
});

test("a bubble sent away drops to half its opacity and is gone at the clock's first step FLOAT_LEAVE_MS on", async () => {
  const { floats, frame, advance, shown, bubbleOf, motionOf, FLOAT_LEAVE_MS } = await setup();
  for (const t of lines(10)) floats.say(say("a", t, 200, 580));
  frame();
  advance(150);
  floats.say(say("a", "l10", 200, 580));
  expect(bubbleOf("l0").classList.contains("is-leaving")).toBe(true);
  expect(motionOf("l0").style.opacity).toBe("0.5");
  expect(shown()).toHaveLength(11);
  advance(FLOAT_LEAVE_MS); // 310 ms: the step at 209 ms was too soon
  expect(shown()).toHaveLength(11);
  advance(STEP);
  expect(shown()).toHaveLength(10);
});

// OME-1184: zoomed out on a phone, bubbles are shown k× their size (room.css --label-scale on the motion wrapper), so
// they're clamped and stacked by the size they're shown at. Their box and push are written in the wrapper's own units.
describe("shown k× their size (phone zoom, OME-1184)", () => {
  test("clamped at the stage edge by the shown width", async () => {
    const { floats, frame, bubbleOf } = await setup();
    floats.scale(2);
    floats.say(say("b", "right", 950, 500));
    frame();
    const r = bubbleOf("right");
    // Shown 200 wide: its box starts at stage x 960 - 4 - 200 = 756, 194 stage px left of the head, 97 of its own.
    expect(r.style.left).toBe("-97px");
    // The head is 3 of its own px from the box's right edge: past a tail's reach, so the tail leans as far as it goes.
    expect(r.style.getPropertyValue("--tail-x")).toBe("94px");
  });

  test("bubbles that only overlap at the shown size stack", async () => {
    const { floats, frame, push } = await setup();
    floats.scale(2);
    floats.say(say("a", "left", 300));
    floats.say(say("b", "right", 400));
    frame();
    expect(push("right")).toBe("0px");
    // Shown 60 tall: clear by 60 + 3 stage px, which is 31.5 px of its own.
    expect(push("left")).toBe("-31.5px");
  });

  test("a new scale re-places the bubbles already up", async () => {
    const { floats, frame, bubbleOf, push } = await setup();
    floats.say(say("a", "left", 300));
    floats.say(say("b", "right", 400));
    frame();
    expect(push("left")).toBe("0px");
    expect(bubbleOf("right").style.left).toBe("-50px");
    floats.scale(2);
    expect(push("left")).toBe("-31.5px");
    floats.scale(1);
    expect(push("left")).toBe("0px");
  });
});

test("an all-caps line (4+ letters) is a shout: the bubble and its twin wear .is-shout; the next line in that node doesn't (OME-1349)", async () => {
  const { floats, layer, bubbleOf, advance, FLOAT_LIFE_MS, FLOAT_LEAVE_MS } = await setup();
  floats.say(say("a", "GOAL!!", 480));
  const p = bubbleOf("GOAL!!");
  expect(p.classList.contains("is-shout")).toBe(true);
  expect(p.parentElement?.parentElement?.querySelector(".float-twin")?.classList.contains("is-shout")).toBe(true);
  advance(FLOAT_LIFE_MS + FLOAT_LEAVE_MS);
  floats.say(say("a", "Goal", 480));
  expect(bubbleOf("Goal").classList.contains("is-shout")).toBe(false);
  expect([...layer.querySelectorAll(".float-twin.is-shout")]).toHaveLength(0);
});
