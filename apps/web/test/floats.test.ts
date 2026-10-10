import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-730 (M8 W1): a chat message floats over its speaker as a set (l) bubble. A fixed pool of 8 DOM nodes, reused
// oldest-first; overlap resolved once per message and once per walk end, never per walk frame. Every box measures
// 100×30 here (the browser measures the real text).

const W = 100;
const H = 30;

async function setup(o: { reduced?: boolean } = {}) {
  const { createFloats, FLOAT_LIFE_MS, FLOAT_LEAVE_MS } = await import("../src/bubbles/floats");
  const layer = document.createElement("div");
  layer.setAttribute("aria-live", "polite");
  let now = 0;
  let measured = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextHandle = 1;
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
    measure: () => {
      measured++;
      return { w: W, h: H };
    },
  });
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
    const say = [...layer.querySelectorAll<HTMLElement>("[data-testid=chat-message]")].find((e) => e.textContent === text);
    const p = say?.closest<HTMLElement>(".ui-float");
    if (p === null || p === undefined) throw new Error(`no bubble "${text}"`);
    return p;
  };
  const texts = () => [...layer.querySelectorAll("[data-testid=chat-message]")].map((e) => e.textContent);
  const push = (text: string) => bubbleOf(text).style.getPropertyValue("--push");
  return { floats, layer, advance, slots, shown, bubbleOf, texts, push, measured: () => measured, FLOAT_LIFE_MS, FLOAT_LEAVE_MS, setNow: (t: number) => (now = t) };
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
  const { floats, shown, bubbleOf } = await setup();
  floats.say(say("a", "hi", 480, 300, { self: true }));
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

test("clamped at the stage edge the box stays inside and the tail leans to the speaker", async () => {
  const { floats, bubbleOf } = await setup();
  floats.say(say("a", "left", 10, 300));
  floats.say(say("b", "right", 950, 500));
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
  const { floats, advance, shown, texts, FLOAT_LIFE_MS } = await setup();
  floats.say(say("a", "bye", 480));
  advance(FLOAT_LIFE_MS - 1);
  expect(shown()).toHaveLength(1);
  advance(1);
  expect(shown()).toHaveLength(0);
  expect(texts()).toEqual([]);
});

test("a message adopted mid-life (pop-out) starts its animation part-way and leaves on time", async () => {
  const { floats, advance, shown, bubbleOf, setNow, FLOAT_LIFE_MS } = await setup();
  setNow(10_000);
  floats.say(say("a", "late", 480, 300, { startedAt: 8_000 }));
  expect(bubbleOf("late").style.animationDelay).toBe("-2000ms");
  advance(FLOAT_LIFE_MS - 2_000);
  expect(shown()).toHaveLength(0);
});

test("8 on screen at most: a ninth message reuses the oldest node, and no node is created or removed", async () => {
  const { floats, slots, shown, texts } = await setup();
  const before = slots();
  for (let i = 0; i < 8; i++) floats.say(say(`m${String(i)}`, `t${String(i)}`, 60 + i * 110));
  expect(shown()).toHaveLength(8);
  const oldest = before.find((s) => s.textContent.includes("t0"));
  floats.say(say("m9", "t9", 480));
  expect(shown()).toHaveLength(8);
  expect(slots()).toEqual(before);
  expect(texts()).not.toContain("t0");
  expect(oldest?.textContent).toContain("t9");
});

test("2 per speaker: a third message sends their oldest away (a short fade), the others stay", async () => {
  const { floats, advance, texts, bubbleOf, FLOAT_LEAVE_MS } = await setup();
  floats.say(say("a", "one", 200));
  floats.say(say("a", "two", 200));
  floats.say(say("b", "other", 700));
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
  const { floats, bubbleOf, push } = await setup();
  floats.say(say("a", "older", 480));
  floats.say(say("b", "newer", 500));
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
  const { floats, advance, push } = await setup();
  floats.say(say("a", "older", 480));
  advance(1000);
  floats.say(say("b", "newer", 500));
  expect(push("older")).toBe("-29px");
});

test("reduced motion has no rise, so the push is the full overlap", async () => {
  const { floats, advance, push } = await setup({ reduced: true });
  floats.say(say("a", "older", 480));
  advance(1000);
  floats.say(say("b", "newer", 500));
  expect(push("older")).toBe("-33px");
});

test("bubbles side by side don't move; a stack of three climbs in order, newest nearest the heads", async () => {
  const { floats, push } = await setup();
  floats.say(say("a", "far-left", 100));
  floats.say(say("b", "far-right", 800));
  expect(push("far-left")).toBe("0px");
  floats.say(say("c", "first", 480));
  floats.say(say("d", "second", 480));
  floats.say(say("e", "third", 480));
  expect(push("third")).toBe("0px");
  expect(push("second")).toBe("-33px");
  expect(push("first")).toBe("-66px");
  expect(push("far-left")).toBe("0px");
});

test("walking moves the speaker's bubbles only; overlap is resolved when the walk ends, never per frame", async () => {
  const { floats, shown, push, measured } = await setup();
  floats.say(say("a", "older", 200));
  floats.say(say("b", "newer", 600));
  const m = measured();
  for (let x = 600; x >= 210; x -= 2) floats.move("b", { x, y: 300 });
  expect(shown().find((s) => s.textContent.includes("newer"))?.style.transform).toBe("translate(210px, 300px)");
  expect(push("older")).toBe("0px");
  floats.settle("b", { x: 210, y: 300 });
  expect(push("older")).toBe("-33px");
  expect(measured()).toBe(m);
});

test("keep: a speaker who left takes their bubbles along", async () => {
  const { floats, texts } = await setup();
  floats.say(say("a", "mine", 200));
  floats.say(say("b", "theirs", 700));
  floats.keep(new Map([["a", null]]));
  expect(texts()).toEqual(["mine"]);
});
