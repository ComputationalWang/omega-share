import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// OME-1406: cinema dim. While the video plays the room dims under one DOM layer (over the canvas, under the tags,
// bubbles and controls) so the screen stands out; it lifts on pause, on end and while the editor is open. A setting,
// on by default, kept in localStorage and parsed, never trusted.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const blocked = {
  getItem: (): string | null => {
    throw new Error("blocked");
  },
  setItem: (): void => {
    throw new Error("blocked");
  },
};

describe("the cinema dim setting", () => {
  test("is on by default, and on for anything stored that isn't exactly off", async () => {
    const { createCinemaDim } = await import("../src/cinema");
    expect(createCinemaDim(memory()).on()).toBe(true);
    expect(createCinemaDim(memory({ "omega.cinema": "garbage" })).on()).toBe(true);
    expect(createCinemaDim(memory({ "omega.cinema": "on" })).on()).toBe(true);
    expect(createCinemaDim(memory({ "omega.cinema": "off" })).on()).toBe(false);
  });

  test("is saved: off then on round-trips through the store", async () => {
    const { createCinemaDim } = await import("../src/cinema");
    const s = memory();
    createCinemaDim(s).set(false);
    expect(s.m.get("omega.cinema")).toBe("off");
    expect(createCinemaDim(s).on()).toBe(false);
    createCinemaDim(s).set(true);
    expect(createCinemaDim(s).on()).toBe(true);
  });

  test("blocked storage: on, and switching still works for this page", async () => {
    const { createCinemaDim } = await import("../src/cinema");
    const c = createCinemaDim(blocked);
    expect(c.on()).toBe(true);
    c.set(false);
    expect(c.on()).toBe(false);
  });
});

describe("the dim layer", () => {
  test("is one decorative layer that never takes a click", async () => {
    const { createCinemaDim } = await import("../src/cinema");
    const { el } = createCinemaDim(memory());
    expect(el.classList.contains("cinema-dim")).toBe(true);
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  test("shows while the video plays, lifts on pause/end and while the editor is open", async () => {
    const { createCinemaDim } = await import("../src/cinema");
    const c = createCinemaDim(memory());
    const lit = () => c.el.classList.contains("is-on");
    expect(lit()).toBe(false);
    c.update(true, false);
    expect(lit()).toBe(true);
    c.update(false, false);
    expect(lit()).toBe(false);
    c.update(true, true);
    expect(lit()).toBe(false);
  });

  test("switching the setting off lifts it at once; on brings it back while playing", async () => {
    const { createCinemaDim } = await import("../src/cinema");
    const c = createCinemaDim(memory());
    const lit = () => c.el.classList.contains("is-on");
    c.update(true, false);
    c.set(false);
    expect(lit()).toBe(false);
    c.set(true);
    expect(lit()).toBe(true);
  });
});

// OME-1502: the room's mood is a fixed tint on the same layer; the dim stacks on it, no second layer.
describe("the room mood on the dim layer", () => {
  test("warm, cool and night mark the layer; none clears it; the layer stays one childless element", async () => {
    const { createCinemaDim } = await import("../src/cinema");
    const c = createCinemaDim(memory());
    for (const m of ["warm", "cool", "night"] as const) {
      c.mood(m);
      expect(c.el.dataset["mood"]).toBe(m);
    }
    c.mood("none");
    expect(c.el.hasAttribute("data-mood")).toBe(false);
    expect(c.el.childElementCount).toBe(0);
  });

  test("the dim comes and goes over a mood without touching it", async () => {
    const { createCinemaDim } = await import("../src/cinema");
    const c = createCinemaDim(memory());
    c.mood("night");
    c.update(true, false);
    expect(c.el.classList.contains("is-on")).toBe(true);
    expect(c.el.dataset["mood"]).toBe("night");
    c.update(false, false);
    expect(c.el.dataset["mood"]).toBe("night");
  });
});

describe("room.css", () => {
  const css = readFileSync(new URL("../src/room.css", import.meta.url), "utf8");
  test("the layer fills the stage, lets clicks through, and fades in over 400 ms in CSS (no canvas filter)", () => {
    const rule = /\.cinema-dim\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/inset:\s*0/);
    expect(rule).toMatch(/pointer-events:\s*none/);
    // The mood holds the layer visible, so the dim fades its background colour, not the layer's opacity (OME-1502).
    expect(rule).toMatch(/transition:\s*background-color 400ms/);
    expect(css).toMatch(/\.cinema-dim\.is-on\s*\{[^}]*background-color:\s*rgb\(8 6 18 \/ 0\.45\)/);
    expect(css).not.toMatch(/filter:\s*brightness/);
  });
  test("each mood is a fixed rgba tint with a blend mode; none has no rule (OME-1502)", () => {
    expect(css).toMatch(/\.cinema-dim\[data-mood\]\s*\{[^}]*mix-blend-mode:\s*multiply/);
    for (const m of ["warm", "cool", "night"]) {
      expect(css).toMatch(new RegExp(`\\.cinema-dim\\[data-mood="${m}"\\]\\s*\\{[^}]*background-image:\\s*linear-gradient\\(rgb\\([\\d ]+/ 0\\.\\d+\\)`));
    }
    expect(css).not.toMatch(/data-mood="none"/);
  });
  test("prefers-reduced-motion: no fade, only the end state", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.cinema-dim\s*\{\s*transition:\s*none/);
  });
});
