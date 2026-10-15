import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  localStorage.clear();
});

// OME-1184: on a phone the room window zooms. Two fingers pinch it around their midpoint, three keys (zoom in, zoom out,
// fit) do it for people who can't pinch, and the zoom is this viewer's alone: remembered in localStorage, never sent.
// Off the phone nothing changes: no keys, and a pinch does nothing.

const VIEW = { w: 390, h: 270 };
const FIT = 390 / 960;

async function setup() {
  const { createRoomWindow } = await import("../src/room-window");
  const clip = document.createElement("div");
  const stage = document.createElement("div");
  clip.append(stage);
  document.body.append(clip);
  const win = createRoomWindow(clip, stage, () => ({ x: 480, y: 300 }));
  const key = (name: string): HTMLButtonElement => {
    const k = clip.querySelector<HTMLButtonElement>(`[data-testid="room-zoom-${name}"]`);
    if (k === null) throw new Error(`no ${name} key`);
    return k;
  };
  const zoom = (): number => {
    const m = /scale\(([\d.]+)\)/.exec(stage.style.transform);
    return m?.[1] === undefined ? 1 : Number(m[1]);
  };
  const pointer = (type: string, id: number, x: number, y: number): void => {
    clip.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, isPrimary: id === 1, button: 0, bubbles: true, pointerType: "touch" }));
  };
  return { win, clip, stage, key, zoom, pointer };
}

describe("on a phone", () => {
  test("three labelled keys zoom in, zoom out and fit the whole stage", async () => {
    const { win, key, zoom } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    expect(key("in").ariaLabel).toBe("Zoom in");
    expect(key("out").ariaLabel).toBe("Zoom out");
    expect(key("fit").ariaLabel).toBe("Fit the room");
    expect(zoom()).toBe(1);
    key("in").click();
    expect(zoom()).toBeGreaterThan(1);
    key("fit").click();
    expect(zoom()).toBeCloseTo(FIT, 5);
    key("out").click();
    expect(zoom()).toBeCloseTo(FIT, 5);
  });

  test("a two-finger pinch zooms around the fingers, and the zoom is remembered on this device", async () => {
    const { win, zoom, pointer } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    pointer("pointerdown", 1, 150, 135);
    pointer("pointerdown", 2, 250, 135);
    pointer("pointermove", 1, 100, 135);
    pointer("pointermove", 2, 300, 135);
    pointer("pointerup", 1, 100, 135);
    pointer("pointerup", 2, 300, 135);
    expect(zoom()).toBe(2);
    expect(localStorage.getItem("omega.roomZoom")).toBe("2");
    expect(win.pan().x).toBeGreaterThan(0);
  });

  test("a stored zoom comes back, clamped to this window", async () => {
    localStorage.setItem("omega.roomZoom", "1.5");
    const a = await setup();
    a.win.set(true, VIEW.w, VIEW.h);
    expect(a.zoom()).toBe(1.5);
    localStorage.setItem("omega.roomZoom", "0.01");
    const b = await setup();
    b.win.set(true, VIEW.w, VIEW.h);
    expect(b.zoom()).toBeCloseTo(FIT, 5);
  });

  test("zoomed out, names and bubbles get a counter-scale so they stay readable", async () => {
    const { win, stage, key } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    expect(stage.style.getPropertyValue("--label-scale")).toBe("1");
    key("fit").click();
    expect(Number(stage.style.getPropertyValue("--label-scale"))).toBeCloseTo(0.85 / FIT, 5);
  });
});

describe("off the phone", () => {
  test("no zoom keys, and a pinch does nothing", async () => {
    const { win, clip, stage, pointer } = await setup();
    win.set(false, 0, 0);
    for (const k of clip.querySelectorAll<HTMLElement>("[data-testid^='room-zoom-']")) expect(k.closest("[hidden]")).not.toBeNull();
    stage.style.transform = "scale(0.5)";
    pointer("pointerdown", 1, 150, 135);
    pointer("pointerdown", 2, 250, 135);
    pointer("pointermove", 2, 350, 135);
    pointer("pointerup", 2, 350, 135);
    expect(stage.style.transform).toBe("scale(0.5)");
    expect(stage.style.getPropertyValue("--label-scale")).toBe("");
  });
});
