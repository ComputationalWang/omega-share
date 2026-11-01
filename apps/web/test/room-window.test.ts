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
/** The room shows beside the zoom keys' 52 px column (OME-1302): Fit is the room's walls (660×532 stage px, OME-2148)
 * whole in that 338×270 pane, so here its height. */
const FIT = 270 / 532;

async function setup() {
  const { createRoomWindow } = await import("../src/room-window");
  const clip = document.createElement("div");
  const stage = document.createElement("div");
  clip.append(stage);
  document.body.append(clip);
  const at = { home: { x: 480, y: 300 } };
  const labels: number[] = [];
  const sides: [number, number, number][] = [];
  const win = createRoomWindow(clip, stage, () => at.home, (k) => labels.push(k), (x0, x1, y1) => sides.push([x0, x1, y1]));
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
  return { win, clip, stage, key, zoom, pointer, at, labels, sides };
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

  // OME-2118: a stacked name tag that would drop past the window's bottom rises instead, so the stage needs that bottom.
  test("the window's settled sides carry its bottom edge in stage px; off the phone, none", async () => {
    const { win, key, zoom, sides } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    key("in").click();
    const [x0, x1, y1] = sides.at(-1) ?? [];
    expect(x0).toBeCloseTo(win.pan().x, 5);
    expect(x1).toBeCloseTo(win.pan().x + (VIEW.w - 52) / zoom(), 5);
    expect(y1).toBeCloseTo(win.pan().y + VIEW.h / zoom(), 5);
    win.set(false, VIEW.w, VIEW.h);
    expect(sides.at(-1)?.[2]).toBe(Infinity);
  });
});

describe("on a phone, the zoom keys' band (OME-1302, QA OME-1300 F3/F4)", () => {
  test("a tall window has the keys in a column beside the room, a short one in a row under it, a sliver none at all", async () => {
    const { win, clip } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    expect(clip.dataset["keys"]).toBe("column");
    expect(clip.style.visibility).toBe("");
    win.set(true, VIEW.w, 120);
    expect(clip.dataset["keys"]).toBe("row");
    expect(clip.style.visibility).toBe("");
    win.set(true, VIEW.w, 40);
    expect(clip.style.visibility).toBe("hidden");
    win.set(false, 960, 40);
    expect(clip.style.visibility).toBe("");
  });

  test("a wide short window (a phone held sideways, OME-1841) has the keys in a row beside the room, so the room keeps its height", async () => {
    const { win, clip } = await setup();
    win.set(true, 540, 120);
    expect(clip.dataset["keys"]).toBe("side");
    win.set(true, 390, 120);
    expect(clip.dataset["keys"]).toBe("row");
  });

  test("a wide window shorter than the portrait floor (Pixel 7 landscape, 863×360, OME-2103) still shows the room beside its key row", async () => {
    const { win, clip } = await setup();
    win.set(true, 540, 90);
    expect(clip.dataset["keys"]).toBe("side");
    expect(clip.style.visibility).toBe("");
    win.set(true, 540, 40);
    expect(clip.style.visibility).toBe("hidden");
  });

  test("windowH: a wide window takes what the column leaves if the room shows in it, else the keys' column and the column scrolls", async () => {
    const { windowH, KEYS_COLUMN_H } = await import("../src/room-window");
    expect(windowH(540, 120)).toBe(120);
    expect(windowH(540, 40)).toBe(KEYS_COLUMN_H);
    expect(windowH(395, 105)).toBe(KEYS_COLUMN_H);
    expect(windowH(540, 200)).toBe(200);
    // Its keys in a row beside it need one key's height, not the portrait floor (OME-2103: 90 px at 863×360).
    expect(windowH(540, 90)).toBe(90);
  });
});

describe("on a phone, edges", () => {
  test("the bubbles hear the label scale with the CSS, once per change", async () => {
    const { win, key, labels } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    key("fit").click();
    expect(labels.at(0)).toBe(1);
    expect(labels.at(-1)).toBeCloseTo(0.85 / FIT, 5);
  });

  test("the zoom keys don't stop the window following the seats", async () => {
    const { win, key, at } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    key("in").click();
    at.home = { x: 200, y: 300 };
    win.set(true, VIEW.w, VIEW.h);
    // At 1.25× the pane (390 − the keys' 52 px) covers 270.4 stage px: centred on x 200 its left edge is at 65.
    expect(win.pan().x).toBe(65);
  });

  test("zoomed in, focus on something past the window's right edge pans it into view", async () => {
    const { win, stage, key } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    key("in").click();
    key("in").click();
    key("in").click();
    key("in").click();
    const before = win.pan().x;
    // Stage x 600 at 2×, measured from the stage's own top-left (happy-dom's rects are zero).
    const seat = document.createElement("button");
    seat.getBoundingClientRect = () => ({ left: 1200, top: 600, width: 0, height: 0, right: 1200, bottom: 600, x: 1200, y: 600, toJSON: () => ({}) });
    stage.append(seat);
    seat.focus();
    expect(win.pan().x).toBeGreaterThan(before);
  });

  test("a tap's focus doesn't pan: the seat stays under the finger, so its click lands (OME-1841, a seat near the edge)", async () => {
    const { win, stage, key } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    for (let i = 0; i < 4; i++) key("in").click();
    const before = win.pan();
    const seat = document.createElement("button");
    seat.getBoundingClientRect = () => ({ left: 1200, top: 600, width: 0, height: 0, right: 1200, bottom: 600, x: 1200, y: 600, toJSON: () => ({}) });
    stage.append(seat);
    seat.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 380, clientY: 135, isPrimary: true, button: 0, bubbles: true, pointerType: "touch" }));
    seat.focus();
    expect(win.pan()).toEqual(before);
  });

  test("a pinch that starts on a seat keeps going when the seat loses the finger to the window (OME-1197)", async () => {
    const { win, stage, zoom, pointer } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    const seat = document.createElement("button");
    stage.append(seat);
    // The first finger lands on a seat (which holds it, touch's implicit capture) and wanders a little.
    seat.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 150, clientY: 135, isPrimary: true, button: 0, bubbles: true, pointerType: "touch" }));
    pointer("pointermove", 1, 154, 135);
    pointer("pointerdown", 2, 254, 135);
    // The window takes both fingers for the pinch: the seat hears it lost finger 1, and that bubbles up.
    seat.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1, pointerType: "touch", bubbles: true }));
    pointer("pointermove", 1, 104, 135);
    pointer("pointermove", 2, 304, 135);
    pointer("pointerup", 1, 104, 135);
    pointer("pointerup", 2, 304, 135);
    expect(zoom()).toBe(2);
  });

  test("a finger the window lost track of never makes the next touch a pinch", async () => {
    const { win, clip, zoom, pointer } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    pointer("pointerdown", 1, 150, 135);
    clip.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1, pointerType: "touch", bubbles: true }));
    const before = win.pan().x;
    clip.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, clientX: 200, clientY: 135, isPrimary: true, button: 0, bubbles: true, pointerType: "touch" }));
    clip.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 260, clientY: 135, isPrimary: true, bubbles: true, pointerType: "touch" }));
    clip.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, clientX: 260, clientY: 135, isPrimary: true, bubbles: true, pointerType: "touch" }));
    expect(zoom()).toBe(1);
    expect(win.pan().x).toBe(before - 60);
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

// OME-1490: on a computer the wheel zooms the fitted room around the pointer; the Fit key goes back to the whole room
// (a double-click on the floor is a jog, OME-1350).
describe("on a computer", () => {
  /** The room fitted at half size: a 480×266 box. */
  const FIT = 0.5;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const wheel = (clip: HTMLElement, deltaY: number, x = 240, y = 133, ctrlKey = false): WheelEvent => {
    const ev = new WheelEvent("wheel", { deltaY, clientX: x, clientY: y, ctrlKey, bubbles: true, cancelable: true });
    clip.dispatchEvent(ev);
    return ev;
  };

  test("at 1× the room is fitted as before", async () => {
    const { win, stage } = await setup();
    const { stageTransform } = await import("../src/layout");
    win.desk(FIT);
    expect(stage.style.transform).toBe(stageTransform(FIT));
  });

  test("wheel up zooms in, wheel down zooms out, once a frame, and the page doesn't scroll or zoom", async () => {
    const { win, clip, zoom } = await setup();
    win.desk(FIT);
    const a = wheel(clip, -100);
    wheel(clip, -100);
    expect(a.defaultPrevented).toBe(true);
    expect(zoom()).toBe(FIT);
    await frame();
    expect(zoom()).toBeGreaterThan(FIT * 1.25);
    const zoomed = zoom();
    expect(wheel(clip, 40, 240, 133, true).defaultPrevented).toBe(true);
    await frame();
    expect(zoom()).toBeLessThan(zoomed);
    expect(zoom()).toBeGreaterThan(FIT);
  });

  test("the zoom is remembered on this device, apart from the phone's, and the Fit key, shown only zoomed in, goes back to 1×", async () => {
    const { win, clip, stage, key } = await setup();
    const { stageTransform } = await import("../src/layout");
    win.desk(FIT);
    expect(key("fit").closest("[hidden]")).not.toBeNull();
    wheel(clip, -1000);
    await frame();
    expect(localStorage.getItem("omega.roomZoomDesk")).toBe("2");
    expect(localStorage.getItem("omega.roomZoom")).toBeNull();
    expect(key("fit").closest("[hidden]")).toBeNull();
    const b = await setup();
    b.win.desk(FIT);
    expect(b.zoom()).toBe(FIT * 2);
    key("fit").click();
    expect(stage.style.transform).toBe(stageTransform(FIT));
    expect(localStorage.getItem("omega.roomZoomDesk")).toBe("1");
    expect(key("fit").closest("[hidden]")).not.toBeNull();
  });

  // OME-1811: at an integer scale the band can be smaller than the room (1× at 1280×800): it looks at the seats first,
  // a mouse drag looks around in both directions, its click is dropped, and the Fit key brings back the seats.
  test("a band smaller than the room looks at the seats, a mouse drag pans it (inside the room), and Fit goes back", async () => {
    const { win, clip, stage, key } = await setup();
    win.desk(1, { w: 900, h: 300 });
    expect(stage.style.transform).toBe("translate(-30px, -150px) scale(1)");
    const mouse = (type: string, x: number, y: number): void => {
      clip.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: y, isPrimary: true, button: 0, bubbles: true, pointerType: "mouse" }));
    };
    mouse("pointerdown", 400, 200);
    mouse("pointermove", 380, 160);
    await frame();
    expect(stage.style.transform).toBe("translate(-50px, -190px) scale(1)");
    mouse("pointermove", 0, 0);
    await frame();
    mouse("pointerup", 0, 0);
    expect(stage.style.transform).toBe("translate(-60px, -292px) scale(1)");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    clip.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    key("fit").click();
    expect(stage.style.transform).toBe("translate(-30px, -150px) scale(1)");
  });

  // OME-2117: I walk out of the band (a swap room's far side): it follows me there, unless the viewer looked around.
  test("in a band, rehome follows a new home until a mouse drag moves the view", async () => {
    const { win, clip, stage, at } = await setup();
    win.desk(1, { w: 900, h: 300 });
    at.home = { x: 480, y: 400 };
    win.rehome();
    expect(stage.style.transform).toBe("translate(-30px, -250px) scale(1)");
    const mouse = (type: string, x: number, y: number): void => {
      clip.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: y, isPrimary: true, button: 0, bubbles: true, pointerType: "mouse" }));
    };
    mouse("pointerdown", 400, 200);
    mouse("pointermove", 400, 240);
    await frame();
    mouse("pointerup", 400, 240);
    const looked = stage.style.transform;
    at.home = { x: 480, y: 300 };
    win.rehome();
    expect(stage.style.transform).toBe(looked);
  });

  // OME-1811: the browser scrolls the clip to show something cropped (find in page, a screen reader): that's the pan.
  test("in a band, a scroll of the clip becomes the view's pan, and the clip is left unscrolled", async () => {
    const { win, clip, stage } = await setup();
    win.desk(1, { w: 900, h: 300 });
    clip.scrollTop = 40;
    clip.scrollLeft = 10;
    clip.dispatchEvent(new Event("scroll"));
    expect(stage.style.transform).toBe("translate(-40px, -190px) scale(1)");
    expect(clip.scrollTop).toBe(0);
    expect(clip.scrollLeft).toBe(0);
  });

  test("on the phone the wheel does nothing new", async () => {
    const { win, clip, zoom } = await setup();
    win.set(true, VIEW.w, VIEW.h);
    expect(wheel(clip, -100).defaultPrevented).toBe(false);
    await frame();
    expect(zoom()).toBe(1);
  });

  // OME-2148: at 1280×800 the band fits the room below 1×; its names and bubbles stay readable, as the phone's do.
  test("fitted below 1×, names and bubbles get the phone's counter-scale; at 1× none", async () => {
    const { win, clip, stage, labels } = await setup();
    win.desk(FIT);
    expect(Number(stage.style.getPropertyValue("--label-scale"))).toBeCloseTo(0.85 / FIT, 5);
    expect(labels.at(-1)).toBeCloseTo(0.85 / FIT, 5);
    expect(clip.classList.contains("is-fit")).toBe(true);
    win.desk(1);
    expect(labels.at(-1)).toBe(1);
    expect(clip.classList.contains("is-fit")).toBe(false);
  });
});
