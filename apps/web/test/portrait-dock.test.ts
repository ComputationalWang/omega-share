import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => { GlobalRegistrator.register(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });

test("sharing opens the existing queue in a sheet and closing returns focus to its link key", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const root = document.createElement("section");
  const log = document.createElement("ol");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  const composer = document.createElement("form");
  const field = document.createElement("input");
  composer.append(field);
  const queue = document.createElement("section");
  const url = document.createElement("input");
  queue.append(url);
  root.append(log, composer, queue);
  document.body.replaceChildren(root);
  const dock = createPortraitDock({ root, log, composer, queue, settings: [] });
  dock.setActive(true);
  dock.link.click();
  expect(dock.sheet.open).toBe(true);
  expect(dock.sheet.contains(queue)).toBe(true);
  expect(document.activeElement).toBe(url);
  dock.close();
  expect(queue.parentElement).toBe(root);
  expect(document.activeElement).toBe(dock.link);
  expect(log.getAttribute("aria-live")).toBe("polite");
});

test("portrait room gives up its crop height before pushing the composer below the viewport", async () => {
  const { portraitLayout } = await import("../src/layout");
  const full = portraitLayout(360, 430, null, false);
  expect(full.height).toBe(430);
  expect(full.stage.h).toBeGreaterThan(0);
  const keyboard = portraitLayout(360, 260, null, true);
  expect(keyboard.stage.h).toBe(0);
  expect(keyboard.controls.h).toBe(0);
  expect(keyboard.tv.h).toBe(203);
  expect(keyboard.height).toBe(260);
});

test("joining portrait immediately docks the panel keys above the composer", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const root = document.createElement("section");
  const log = document.createElement("div");
  const composer = document.createElement("form");
  const queue = document.createElement("section");
  root.append(log, composer, queue);
  document.body.replaceChildren(root);
  const dock = createPortraitDock({ root, log, composer, queue, settings: [] });
  dock.setActive(true);
  expect(composer.previousElementSibling).toBe(dock.keys);
});

test("the sheet wraps Tab from its last field to Close and ignores an old close event after reopening", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const root = document.createElement("section");
  const log = document.createElement("div");
  const composer = document.createElement("form");
  const queue = document.createElement("section");
  const url = document.createElement("input");
  queue.append(url);
  root.append(log, composer, queue);
  document.body.replaceChildren(root);
  const dock = createPortraitDock({ root, log, composer, queue, settings: [] });
  dock.setActive(true);
  dock.link.click();
  dock.close();
  dock.link.click();
  dock.sheet.dispatchEvent(new Event("close"));
  expect(dock.sheet.contains(queue)).toBe(true);
  url.focus();
  url.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(dock.sheet.querySelector('[data-testid="portrait-sheet-close"]'));
});

test("viewport resize and scroll keep the portrait dock above the keyboard, then restore on rotation", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const native = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  try {
    const root = document.createElement("section");
    const log = document.createElement("div");
    const composer = document.createElement("form");
    const queue = document.createElement("section");
    root.append(log, composer, queue);
    document.body.replaceChildren(root);
    const dock = createPortraitDock({ root, log, composer, queue, settings: [] });
    dock.setActive(true);
    viewport.height = window.innerHeight - 300;
    viewport.dispatchEvent(new Event("resize"));
    expect(root.classList.contains("portrait-typing")).toBe(true);
    expect(root.style.getPropertyValue("--portrait-height")).toBe(`${String(window.innerHeight - 300)}px`);
    viewport.offsetTop = 24;
    viewport.dispatchEvent(new Event("scroll"));
    expect(root.style.getPropertyValue("--portrait-top")).toBe("24px");
    dock.setActive(false);
    expect(root.classList.contains("portrait-typing")).toBe(false);
    expect(root.style.getPropertyValue("--portrait-height")).toBe("");
  } finally {
    Object.defineProperty(window, "visualViewport", native ?? { configurable: true, value: undefined });
  }
});

test("focusing a portrait shelf key asks the browser to expose its whole box, without moving desktop focus", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const root = document.createElement("section");
  const log = document.createElement("div");
  const composer = document.createElement("form");
  const queue = document.createElement("section");
  const shelf = document.createElement("div");
  const mute = document.createElement("button");
  shelf.append(mute);
  root.append(shelf, log, composer, queue);
  document.body.replaceChildren(root);
  // Happy DOM has no layout engine. Observe the request at the browser scrolling boundary;
  // the committed CI hit probes verify actual scroll geometry and touch delivery.
  let requested: ScrollIntoViewOptions | boolean | undefined;
  mute.scrollIntoView = (options) => { requested = options; };
  const dock = createPortraitDock({ root, log, composer, queue, shelf, settings: [] });
  dock.setActive(true);
  mute.focus();
  expect(requested).toEqual({ block: "nearest", inline: "nearest" });
  dock.setActive(false);
  requested = undefined;
  mute.blur();
  mute.focus();
  expect(requested).toBeUndefined();
});

test("the keyboard portrait picture can receive scroll focus and restores its original semantics on exit", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const native = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  try {
    const root = document.createElement("section");
    const log = document.createElement("div");
    const composer = document.createElement("form");
    const queue = document.createElement("section");
    const pictureRegion = document.createElement("div");
    pictureRegion.setAttribute("role", "group");
    pictureRegion.setAttribute("aria-label", "Room media");
    pictureRegion.tabIndex = -1;
    root.append(pictureRegion, log, composer, queue);
    document.body.replaceChildren(root);
    const dock = createPortraitDock({ root, log, composer, queue, pictureRegion, settings: [] });
    dock.setActive(true);
    viewport.height = window.innerHeight - 300;
    viewport.dispatchEvent(new Event("resize"));
    expect(pictureRegion.tabIndex).toBe(0);
    expect(pictureRegion.getAttribute("role")).toBe("region");
    expect(pictureRegion.getAttribute("aria-label")).toBe("Video; scroll to see the whole picture");
    pictureRegion.focus();
    expect(document.activeElement === pictureRegion).toBe(true);
    dock.setActive(false);
    expect(pictureRegion.tabIndex).toBe(-1);
    expect(pictureRegion.getAttribute("role")).toBe("group");
    expect(pictureRegion.getAttribute("aria-label")).toBe("Room media");
  } finally {
    Object.defineProperty(window, "visualViewport", native ?? { configurable: true, value: undefined });
  }
});

// OME-1586: the message field sits in a `.chat-field` wrapper with the palette key; the link key still leads it.
test("the link key goes before the field's wrapper when the field is wrapped", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const root = document.createElement("section");
  const log = document.createElement("ol");
  const composer = document.createElement("form");
  const wrap = document.createElement("span");
  wrap.className = "chat-field";
  wrap.append(document.createElement("input"));
  composer.append(wrap);
  const queue = document.createElement("section");
  root.append(log, composer, queue);
  document.body.replaceChildren(root);
  const dock = createPortraitDock({ root, log, composer, queue, settings: [] });
  dock.setActive(true);
  expect(dock.link.nextElementSibling).toBe(wrap);
});

test("the portrait room marks the body, so its page rules need no body:has() (OME-1755)", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const root = document.createElement("section");
  const log = document.createElement("div");
  const composer = document.createElement("form");
  const queue = document.createElement("section");
  root.append(log, composer, queue);
  document.body.replaceChildren(root);
  const dock = createPortraitDock({ root, log, composer, queue, settings: [] });
  dock.setActive(true);
  expect(document.body.classList.contains("room-is-portrait")).toBe(true);
  dock.setActive(false);
  expect(document.body.classList.contains("room-is-portrait")).toBe(false);
});
