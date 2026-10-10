import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EMOTE_BURST, type ClientMessage } from "@omega/shared";
import type { Point, Rect } from "../src/layout";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-415: the emote key; pressing a sticker (or keys 1–6) sends `emote`; the key cools when the local bucket
// (emotes.ts) is empty, so we never send what the server would drop. OME-732 (M8 W3): the key opens set (l)'s emote
// wheel (T opens it too), the six stickers clockwise from 12 in key order, over your own head.

interface Where {
  head: Point | null;
  room: Rect;
}

async function setup(o: { sendOk?: boolean; where?: Where } = {}) {
  const { createEmotePicker } = await import("../src/emote/picker");
  let now = 0;
  const sent: ClientMessage[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const sendOk = o.sendOk ?? true;
  const picker = createEmotePicker({
    send: (m) => {
      if (sendOk) sent.push(m);
      return sendOk;
    },
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
    ...(o.where === undefined ? {} : { locate: () => o.where ?? null }),
  });
  const form = document.createElement("form");
  const field = document.createElement("input");
  const outside = document.createElement("button");
  form.append(picker.root, field);
  document.body.replaceChildren(form, outside);
  const key = picker.root.querySelector("[data-testid=emote-key]");
  if (!(key instanceof HTMLButtonElement)) throw new Error("no emote key");
  const menu = (): HTMLElement => {
    const m = picker.root.querySelector("[data-testid=emote-menu]");
    if (!(m instanceof HTMLElement)) throw new Error("no wheel yet");
    return m;
  };
  const items = (): HTMLButtonElement[] => [...menu().querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
  const press = (k: string, init: KeyboardEventInit = {}, target: EventTarget | null = document.activeElement ?? document.body): boolean => {
    const ev = new KeyboardEvent("keydown", { key: k, cancelable: true, ...init });
    Object.defineProperty(ev, "target", { value: target });
    return picker.key(ev);
  };
  const hub = (): Element | null => menu().querySelector(".ui-wheel-hub");
  const chip = (): string => menu().querySelector(".ui-wheel-label")?.textContent ?? "";
  return { picker, key, menu, items, sent, timers, press, hub, chip, field, outside, at: (t: number) => (now = t) };
}

describe("emote wheel", () => {
  test("the key is the menu's trigger, with set (l)'s wheel icon; no wheel in the DOM until the first open", async () => {
    const { key, picker } = await setup();
    expect(key.getAttribute("aria-haspopup")).toBe("menu");
    expect(key.getAttribute("aria-expanded")).toBe("false");
    expect(key.getAttribute("aria-keyshortcuts")).toBe("T");
    expect(key.querySelector(".ui-icon-wheel")).not.toBeNull();
    expect(picker.root.querySelector("[data-testid=emote-menu]")).toBeNull();
  });

  test("the key opens the wheel: a menu labelled Emotes, the six stickers in key order, clockwise from 12", async () => {
    const { key, menu, items, hub, chip } = await setup();
    key.click();
    const m = menu();
    expect(m.hidden).toBe(false);
    expect(m.classList.contains("ui-wheel")).toBe(true);
    expect(m.getAttribute("role")).toBe("menu");
    expect(m.getAttribute("aria-label")).toBe("Emotes");
    expect(key.getAttribute("aria-expanded")).toBe("true");
    const slots = items();
    // reference.css places .ui-wheel-slot:nth-child(1..6) clockwise from 12: the slots are the wheel's first six children.
    expect([...m.children].slice(0, 6)).toEqual(slots);
    expect(slots.every((b) => b.classList.contains("ui-wheel-slot"))).toBe(true);
    expect(slots.map((b) => b.getAttribute("aria-label"))).toEqual(["Heart", "Laugh", "Question", "Surprise", "Clap", "Wave"]);
    expect(slots.map((b) => b.getAttribute("aria-keyshortcuts"))).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(slots[5]?.querySelector(".ui-emote-pick-wave")).not.toBeNull();
    // Heart is selected and focused (roving tabindex); the hub previews it and the chip names it with its key.
    expect(slots.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    expect(document.activeElement).toBe(slots[0] ?? null);
    expect(hub()?.querySelector(".ui-emote-pick-heart")).not.toBeNull();
    expect(chip()).toBe("Heart1");
    expect(m.querySelector(".ui-wheel-label kbd.ui-kbd")?.textContent).toBe("1");
    key.click();
    expect(m.hidden).toBe(true);
    expect(key.getAttribute("aria-expanded")).toBe("false");
  });

  test("the wheel is built once: reopening reuses the same nodes", async () => {
    const { key, menu, items } = await setup();
    key.click();
    const first = menu();
    const slot = items()[3];
    key.click();
    key.click();
    expect(menu()).toBe(first);
    expect(items()[3]).toBe(slot);
  });

  test("T opens it with Heart focused; T again closes it and focus goes back where it was", async () => {
    const { press, menu, items, outside, key } = await setup();
    outside.focus();
    expect(press("t")).toBe(true);
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(items()[0] ?? null);
    expect(key.getAttribute("aria-expanded")).toBe("true");
    expect(press("T", { shiftKey: false })).toBe(true);
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  test("Escape closes it and focus goes back where it was", async () => {
    const { press, menu, outside } = await setup();
    outside.focus();
    press("t");
    expect(press("Escape")).toBe(true);
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
    expect(press("Escape")).toBe(false);
  });

  test("T is the field's while typing, and ignored with a modifier, during IME composition or with a dialog open", async () => {
    const { press, field, picker } = await setup();
    expect(press("t", {}, field)).toBe(false);
    expect(press("t", { ctrlKey: true })).toBe(false);
    expect(press("t", { altKey: true })).toBe(false);
    expect(press("t", { metaKey: true })).toBe(false);
    expect(press("T", { shiftKey: true })).toBe(false);
    expect(press("t", { isComposing: true })).toBe(false);
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.setAttribute("open", "");
    expect(press("t")).toBe(false);
    dialog.remove();
    expect(picker.root.querySelector("[data-testid=emote-menu]")).toBeNull();
  });

  test("→ and ↓ go clockwise, ← and ↑ back, wrapping; Home and End; the hub and chip follow", async () => {
    const { press, items, hub, chip } = await setup();
    press("t");
    const slots = items();
    const at = (): number => slots.findIndex((b) => b === document.activeElement);
    expect(press("ArrowRight")).toBe(true);
    expect(at()).toBe(1);
    expect(slots.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1]);
    expect(hub()?.querySelector(".ui-emote-pick-laugh")).not.toBeNull();
    expect(chip()).toBe("Laugh2");
    press("ArrowDown");
    expect(at()).toBe(2);
    press("ArrowLeft");
    press("ArrowUp");
    expect(at()).toBe(0);
    press("ArrowLeft");
    expect(at()).toBe(5);
    press("ArrowRight");
    expect(at()).toBe(0);
    press("End");
    expect(at()).toBe(5);
    press("Home");
    expect(at()).toBe(0);
  });

  test("arrows are nobody's while the wheel is closed", async () => {
    const { press } = await setup();
    expect(press("ArrowRight")).toBe(false);
    expect(press("Enter")).toBe(false);
  });

  test("Enter (or Space) sends the selected one, closes, and gives focus back", async () => {
    const { press, menu, sent, outside } = await setup();
    outside.focus();
    press("t");
    press("ArrowRight");
    press("ArrowRight");
    expect(press("Enter")).toBe(true);
    expect(sent).toEqual([{ type: "emote", kind: "question" }]);
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
    press("t");
    expect(press(" ")).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "emote", kind: "heart" });
  });

  test("clicking a slot sends it and closes the wheel", async () => {
    const { key, menu, items, sent } = await setup();
    key.click();
    items()[2]?.click();
    expect(sent).toEqual([{ type: "emote", kind: "question" }]);
    expect(menu().hidden).toBe(true);
    expect(key.getAttribute("aria-expanded")).toBe("false");
  });

  test("hovering a slot previews it in the hub, without moving the selection", async () => {
    const { key, items, hub } = await setup();
    key.click();
    items()[4]?.dispatchEvent(new Event("pointerenter"));
    expect(hub()?.querySelector(".ui-emote-pick-clap")).not.toBeNull();
    expect(items().map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    items()[4]?.dispatchEvent(new Event("pointerleave"));
    expect(hub()?.querySelector(".ui-emote-pick-heart")).not.toBeNull();
  });

  test("Tab closes it and moves on (the key isn't ours)", async () => {
    const { press, menu } = await setup();
    press("t");
    expect(press("Tab")).toBe(false);
    expect(menu().hidden).toBe(true);
  });

  test("close() (your avatar started walking) closes it and gives focus back; closed, it does nothing", async () => {
    const { picker, press, menu, outside } = await setup();
    picker.close();
    outside.focus();
    press("t");
    picker.close();
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  test("keys 1–6 send without opening the wheel; not while typing, and not with a modifier", async () => {
    const { press, sent, picker, field } = await setup();
    expect(press("6")).toBe(true);
    expect(sent).toEqual([{ type: "emote", kind: "wave" }]);
    expect(picker.root.querySelector("[data-testid=emote-menu]")).toBeNull();
    expect(press("1", {}, field)).toBe(false);
    expect(press("1", { ctrlKey: true })).toBe(false);
    expect(press("1", { altKey: true })).toBe(false);
    expect(press("1", { metaKey: true })).toBe(false);
    expect(press("x")).toBe(false);
    expect(sent.length).toBe(1);
  });

  test("a key pick with the wheel open sends it and closes the wheel, like a click (OME-485)", async () => {
    const { key, menu, press, sent } = await setup();
    key.click();
    expect(press("3")).toBe(true);
    expect(sent).toEqual([{ type: "emote", kind: "question" }]);
    expect(menu().hidden).toBe(true);
    expect(key.getAttribute("aria-expanded")).toBe("false");
  });

  test("a held key sends once: key-repeat is swallowed, not spent on the burst (OME-485)", async () => {
    const { press, sent, key, menu } = await setup();
    expect(press("1")).toBe(true);
    for (let i = 0; i < 5; i++) expect(press("1", { repeat: true })).toBe(true);
    expect(sent.length).toBe(1);
    expect(key.classList.contains("is-cooling")).toBe(false);
    // A held T toggles once, too.
    press("t");
    expect(press("t", { repeat: true })).toBe(true);
    expect(menu().hidden).toBe(false);
  });

  test("after a burst: slots disabled (cool), the hub runs the wait dial, the chip says when; nothing more is sent", async () => {
    const { key, items, sent, timers, press, at, hub, chip } = await setup();
    for (let i = 0; i < EMOTE_BURST; i++) press("1");
    expect(sent.length).toBe(EMOTE_BURST);
    expect(key.classList.contains("is-cooling")).toBe(true);
    press("t");
    expect(items().every((b) => b.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(hub()?.querySelector(".ui-wait")).not.toBeNull();
    const timer = timers.at(-1);
    const wait = Math.ceil((timer?.ms ?? 0) / 1000);
    expect(chip()).toBe(`Emotes in ${String(wait)} s`);
    press("Enter");
    items()[0]?.click();
    press("2");
    expect(sent.length).toBe(EMOTE_BURST);
    expect(timer?.ms).toBeGreaterThan(0);
    at(timer?.ms ?? 0);
    timer?.fn();
    expect(key.classList.contains("is-cooling")).toBe(false);
    press("t");
    expect(items().every((b) => b.getAttribute("aria-disabled") !== "true")).toBe(true);
    expect(hub()?.querySelector(".ui-wait")).toBeNull();
    press("2");
    expect(sent.at(-1)).toEqual({ type: "emote", kind: "laugh" });
  });

  test("focus leaving the wheel (a click elsewhere) closes it; moving between its slots doesn't", async () => {
    const { key, menu, items, outside } = await setup();
    key.click();
    items()[1]?.focus();
    expect(menu().hidden).toBe(false);
    outside.focus();
    expect(menu().hidden).toBe(true);
    expect(key.getAttribute("aria-expanded")).toBe("false");
  });

  test("an emote that couldn't be sent (offline) costs no token", async () => {
    const { key, press } = await setup({ sendOk: false });
    for (let i = 0; i < EMOTE_BURST + 2; i++) press("1");
    expect(key.classList.contains("is-cooling")).toBe(false);
  });

  test("it opens over your own head, its tail on it", async () => {
    const { press, menu } = await setup({ where: { head: { x: 500, y: 400 }, room: { x: 0, y: 0, w: 960, h: 600 } } });
    press("t");
    expect(menu().style.left).toBe("423px");
    expect(menu().style.top).toBe("238px");
    expect(menu().classList.contains("no-tail")).toBe(false);
  });

  test("with no avatar of yours in view it docks above the composer, without a tail", async () => {
    const { press, menu } = await setup({ where: { head: null, room: { x: 0, y: 0, w: 960, h: 600 } } });
    press("t");
    expect(menu().classList.contains("no-tail")).toBe(true);
  });
});
