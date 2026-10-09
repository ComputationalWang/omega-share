import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EMOTE_BURST, type ClientMessage } from "@omega/shared";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-415: the emote key and its set (i) picker. Pressing a sticker (or keys 1–6) sends `emote`; the key cools when the
// local bucket (emotes.ts) is empty, so we never send what the server would drop.

async function setup(sendOk = true) {
  const { createEmotePicker } = await import("../src/emote/picker");
  let now = 0;
  const sent: ClientMessage[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const picker = createEmotePicker({
    send: (m) => {
      if (sendOk) sent.push(m);
      return sendOk;
    },
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
  });
  document.body.replaceChildren(picker.root);
  const key = picker.root.querySelector("[data-testid=emote-key]");
  const menu = picker.root.querySelector("[data-testid=emote-menu]");
  if (!(key instanceof HTMLButtonElement) || !(menu instanceof HTMLElement)) throw new Error("no emote key or menu");
  const items = [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
  const press = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): boolean => {
    const ev = new KeyboardEvent("keydown", { key: k, ...init });
    Object.defineProperty(ev, "target", { value: target });
    return picker.key(ev);
  };
  return { picker, key, menu, items, sent, timers, press, at: (t: number) => (now = t) };
}

describe("emote picker", () => {
  test("the key opens a menu of the five stickers, the groove, then the wave, each with its shortcut", async () => {
    const { key, menu, items } = await setup();
    expect(key.getAttribute("aria-haspopup")).toBe("menu");
    expect(key.getAttribute("aria-expanded")).toBe("false");
    expect(key.querySelector(".ui-icon-emote")).not.toBeNull();
    expect(menu.hidden).toBe(true);
    key.click();
    expect(menu.hidden).toBe(false);
    expect(key.getAttribute("aria-expanded")).toBe("true");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(items.map((b) => b.getAttribute("aria-label"))).toEqual(["Heart", "Laugh", "Question", "Surprise", "Clap", "Wave"]);
    expect(items.map((b) => b.getAttribute("aria-keyshortcuts"))).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(items[0]?.title).toBe("Heart (1)");
    expect(items[5]?.querySelector(".ui-emote-pick-wave")).not.toBeNull();
    expect(items[5]?.previousElementSibling?.classList.contains("ui-emotes-sep")).toBe(true);
    key.click();
    expect(menu.hidden).toBe(true);
  });

  test("pressing a sticker sends it and closes the menu", async () => {
    const { key, menu, items, sent } = await setup();
    key.click();
    items[2]?.click();
    expect(sent).toEqual([{ type: "emote", kind: "question" }]);
    expect(menu.hidden).toBe(true);
    expect(key.getAttribute("aria-expanded")).toBe("false");
  });

  test("keys 1–6 send without opening the menu; not while typing, and not with a modifier", async () => {
    const { press, sent, menu } = await setup();
    expect(press("6")).toBe(true);
    expect(sent).toEqual([{ type: "emote", kind: "wave" }]);
    expect(menu.hidden).toBe(true);
    const input = document.createElement("input");
    expect(press("1", {}, input)).toBe(false);
    expect(press("1", { ctrlKey: true })).toBe(false);
    expect(press("1", { altKey: true })).toBe(false);
    expect(press("1", { metaKey: true })).toBe(false);
    expect(press("x")).toBe(false);
    expect(sent.length).toBe(1);
  });

  test("Escape closes an open menu and gives focus back to the key", async () => {
    const { key, menu, press } = await setup();
    key.click();
    expect(press("Escape")).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(key);
    expect(press("Escape")).toBe(false);
  });

  test("after a burst the key cools and the cells are disabled until a token refills; nothing more is sent", async () => {
    const { key, items, sent, timers, press, at } = await setup();
    for (let i = 0; i < EMOTE_BURST; i++) press("1");
    expect(sent.length).toBe(EMOTE_BURST);
    expect(key.classList.contains("is-cooling")).toBe(true);
    expect(items.every((b) => b.getAttribute("aria-disabled") === "true")).toBe(true);
    press("2");
    key.click();
    items[0]?.click();
    expect(sent.length).toBe(EMOTE_BURST);
    const timer = timers.at(-1);
    expect(timer?.ms).toBeGreaterThan(0);
    at(timer?.ms ?? 0);
    timer?.fn();
    expect(key.classList.contains("is-cooling")).toBe(false);
    expect(items.every((b) => b.getAttribute("aria-disabled") !== "true")).toBe(true);
    press("2");
    expect(sent.at(-1)).toEqual({ type: "emote", kind: "laugh" });
  });

  test("focus leaving the picker (a click elsewhere) closes it; moving between its cells doesn't", async () => {
    const { key, menu, items } = await setup();
    const outside = document.createElement("button");
    document.body.append(outside);
    key.click();
    items[1]?.focus();
    expect(menu.hidden).toBe(false);
    outside.focus();
    expect(menu.hidden).toBe(true);
    expect(key.getAttribute("aria-expanded")).toBe("false");
  });

  test("an emote that couldn't be sent (offline) costs no token", async () => {
    const { key, press } = await setup(false);
    for (let i = 0; i < EMOTE_BURST + 2; i++) press("1");
    expect(key.classList.contains("is-cooling")).toBe(false);
  });
});
