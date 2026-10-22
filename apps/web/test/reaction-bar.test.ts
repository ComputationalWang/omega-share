import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EMOTE_BURST, EMOTE_REFILL_MS, type ClientMessage } from "@omega/shared";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-1631: a reaction bar by the player (heart, laugh, wow, clap). Shift+1–4 react (plain 1–9 are the emote keys,
// ? is help, F/C full screen; the command palette has no key). `react` goes through the emote bucket the picker
// shares, since the server charges both to one limit: an empty bucket cools the bar and sends nothing.

async function setup(o: { sendOk?: boolean } = {}) {
  const { createReactionBar } = await import("../src/reactions/bar");
  const { createEmoteBucket } = await import("../src/emote/emotes");
  let now = 0;
  const sent: ClientMessage[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const bucket = createEmoteBucket(0);
  const bar = createReactionBar({
    send: (m) => {
      if (o.sendOk ?? true) sent.push(m);
      return o.sendOk ?? true;
    },
    bucket,
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
  });
  document.body.replaceChildren(bar.root);
  const button = (kind: string): HTMLButtonElement => {
    const b = bar.root.querySelector(`[data-testid=reaction-${kind}]`);
    if (!(b instanceof HTMLButtonElement)) throw new Error(`no ${kind} button`);
    return b;
  };
  const press = (code: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): boolean => {
    const ev = new KeyboardEvent("keydown", { code, key: "!", shiftKey: true, cancelable: true, ...init });
    Object.defineProperty(ev, "target", { value: target });
    return bar.key(ev);
  };
  return { bar, bucket, sent, timers, button, press, at: (t: number) => (now = t) };
}

describe("reaction bar", () => {
  test("four labelled buttons in order, each naming its shortcut", async () => {
    const { bar, button } = await setup();
    const kinds = [...bar.root.querySelectorAll("button")].map((b) => b.dataset["testid"]);
    expect(kinds).toEqual(["reaction-heart", "reaction-laugh", "reaction-wow", "reaction-clap"]);
    expect(button("wow").getAttribute("aria-label")).toBe("Wow");
    expect(button("wow").getAttribute("aria-keyshortcuts")).toBe("Shift+3");
    expect(bar.root.getAttribute("role")).toBe("toolbar");
  });

  test("a click sends react", async () => {
    const { button, sent } = await setup();
    button("laugh").click();
    expect(sent).toEqual([{ type: "react", kind: "laugh" }]);
  });

  test("Shift+1–4 react by physical key, whatever the layout types", async () => {
    const { press, sent } = await setup();
    expect(press("Digit1")).toBe(true);
    expect(press("Digit4", { key: "$" })).toBe(true);
    expect(sent).toEqual([
      { type: "react", kind: "heart" },
      { type: "react", kind: "clap" },
    ]);
  });

  test("not ours: plain digits (emotes), Shift+5, modifiers, typing in a field, IME", async () => {
    const { press, sent } = await setup();
    expect(press("Digit1", { shiftKey: false, key: "1" })).toBe(false);
    expect(press("Digit5")).toBe(false);
    expect(press("Digit1", { ctrlKey: true })).toBe(false);
    expect(press("Digit1", { altKey: true })).toBe(false);
    expect(press("Digit1", { metaKey: true })).toBe(false);
    expect(press("Digit1", { isComposing: true })).toBe(false);
    expect(press("Digit1", {}, document.createElement("input"))).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a held key repeats nothing", async () => {
    const { press, sent } = await setup();
    press("Digit1");
    expect(press("Digit1", { repeat: true })).toBe(true);
    expect(sent.length).toBe(1);
  });

  test("the bucket runs dry: the bar cools, sends nothing, and warms again when a token is back", async () => {
    const { bar, button, sent, timers, at } = await setup();
    for (let i = 0; i < EMOTE_BURST; i++) expect(bar.react("heart")).toBe(true);
    expect(bar.react("heart")).toBe(false);
    expect(sent.length).toBe(EMOTE_BURST);
    expect(bar.root.classList.contains("is-cooling")).toBe(true);
    expect(button("clap").getAttribute("aria-disabled")).toBe("true");
    const t = timers.at(-1);
    if (t === undefined) throw new Error("no warm-up timer");
    expect(t.ms).toBeGreaterThanOrEqual(EMOTE_REFILL_MS);
    at(t.ms);
    t.fn();
    expect(bar.root.classList.contains("is-cooling")).toBe(false);
    expect(button("clap").hasAttribute("aria-disabled")).toBe(false);
    expect(bar.react("clap")).toBe(true);
  });

  test("the bucket is shared: emotes spent elsewhere cool the bar too", async () => {
    const { bar, bucket, sent } = await setup();
    for (let i = 0; i < EMOTE_BURST; i++) bucket.take(0);
    expect(bar.react("wow")).toBe(false);
    expect(sent).toEqual([]);
    expect(bar.root.classList.contains("is-cooling")).toBe(true);
  });

  test("a send that fails (socket down) spends no token", async () => {
    const { bar, bucket } = await setup({ sendOk: false });
    expect(bar.react("heart")).toBe(false);
    for (let i = 0; i < EMOTE_BURST; i++) expect(bucket.take(0)).toBe(true);
  });
});
