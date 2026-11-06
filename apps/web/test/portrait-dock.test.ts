import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => { GlobalRegistrator.register(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });

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
    const dock = createPortraitDock({ root });
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
  const dock = createPortraitDock({ root, shelf });
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
    const dock = createPortraitDock({ root, pictureRegion });
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
test("the portrait room marks the body, so its page rules need no body:has() (OME-1755)", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const root = document.createElement("section");
  const log = document.createElement("div");
  const composer = document.createElement("form");
  const queue = document.createElement("section");
  root.append(log, composer, queue);
  document.body.replaceChildren(root);
  const dock = createPortraitDock({ root });
  dock.setActive(true);
  expect(document.body.classList.contains("room-is-portrait")).toBe(true);
  dock.setActive(false);
  expect(document.body.classList.contains("room-is-portrait")).toBe(false);
});

// OME-2265: docking runs inside the room's first render on a phone. A viewport read after a style write forces a
// layout; reading the viewport first keeps it to the one layout the render needs anyway.
test("docking reads the viewport before it writes any class or style", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const native = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const nativeInner = Object.getOwnPropertyDescriptor(window, "innerHeight");
  const log: string[] = [];
  const viewport = new EventTarget();
  for (const [k, v] of [["height", 500], ["offsetTop", 0], ["scale", 1]] as const) Object.defineProperty(viewport, k, { get: () => { log.push(`read ${k}`); return v; } });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => { log.push("read innerHeight"); return 800; } });
  try {
    const root = document.createElement("section");
    const log2 = document.createElement("div");
    const composer = document.createElement("form");
    const queue = document.createElement("section");
    root.append(log2, composer, queue);
    document.body.replaceChildren(root);
    const dock = createPortraitDock({ root, queueLayout: () => { log.push("write queue"); } });
    const write = (what: string) => (target: object, key: string): void => {
      const fn: unknown = Reflect.get(target, key);
      if (typeof fn !== "function") throw new Error(key);
      Reflect.set(target, key, (...a: unknown[]): unknown => { log.push(`write ${what}`); const r: unknown = Reflect.apply(fn, target, a); return r; });
    };
    write("style")(root.style, "setProperty");
    write("class")(root.classList, "toggle");
    write("body class")(document.body.classList, "toggle");
    dock.setActive(true);
    const firstWrite = log.findIndex((l) => l.startsWith("write"));
    expect(firstWrite).toBeGreaterThan(0);
    expect(log.slice(firstWrite).filter((l) => l.startsWith("read"))).toEqual([]);
    expect(root.style.getPropertyValue("--portrait-height")).toBe("500px");
    expect(root.classList.contains("portrait-typing")).toBe(true);
  } finally {
    Object.defineProperty(window, "visualViewport", native ?? { configurable: true, value: undefined });
    if (nativeInner !== undefined) Object.defineProperty(window, "innerHeight", nativeInner);
  }
});
