import { describe, expect, test } from "bun:test";
import { ONAIR_FRAME_MS, liveCss } from "./live";

// Any atlas key resolves; distinct offsets so frame 0, frame 1 and "off" read differently in the CSS.
const keys = ["glyph/onair/0", "glyph/onair/1", "glyph/onair-off"];
const rects = new Proxy<Record<string, { x: number; y: number }>>(
  {},
  { get: (_t, k) => (typeof k === "string" ? { x: Math.max(0, keys.indexOf(k)) * 8, y: 0 } : undefined) },
);
const css = liveCss(rects);

const block = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  expect(at).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", css.indexOf("{", at)) + 1);
};
const keyframes = (name: string): string => {
  const m = new RegExp(`@keyframes ${name} \\{((?:[^{}]*\\{[^{}]*\\})*)\\s*\\}`).exec(css);
  expect(m).not.toBeNull();
  return m?.[1] ?? "";
};

// OME-201: background-position animations run on the main thread every frame; opacity runs on the compositor.
describe("on-air lamp blink (OME-201)", () => {
  test("its keyframes animate only opacity", () => {
    const kf = keyframes("ui-onair");
    expect(kf).not.toContain("background-position");
    expect(kf).toContain("opacity");
    const props = [...kf.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(props.every((p) => p === "opacity" || p === "transform")).toBe(true);
  });

  test("the lamp itself is static; frame 1 is a layer that blinks at the same cadence", () => {
    expect(block(".ui-onair")).not.toContain("animation");
    const layer = block(".ui-onair::after");
    expect(layer).toContain(`animation: ui-onair ${String(ONAIR_FRAME_MS * 2)}ms steps(1) infinite`);
    expect(layer).toContain("background-position: var(--f1)");
  });

  test("behind live and reduced motion stop the blink", () => {
    expect(css).toMatch(/\.ui-live\.is-behind \.ui-onair::after \{[^}]*display: none/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.ui-onair::after[^{]*\{ animation: none; \}/);
  });
});
