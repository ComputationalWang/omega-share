import { describe, expect, test } from "bun:test";
import type { UserConfig } from "vite";
import { DEV_STYLE_NONCE, withStyleNonce } from "../csp";
import viteConfig from "../vite.config";

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

/**
 * OME-1023: the room's CSS is a JS import (room.ts → room.css). `vite build` emits it as a <link>, which
 * `style-src 'self'` allows; the dev server injects it as an inline <style>, which the meta CSP blocks.
 * So in dev only, Vite stamps its injected styles with a nonce and style-src allows that nonce.
 */
describe("withStyleNonce", () => {
  test("adds the nonce to style-src and leaves the rest of the CSP alone", () => {
    const out = withStyleNonce(html, DEV_STYLE_NONCE);
    expect(out).toContain(`style-src 'self' 'nonce-${DEV_STYLE_NONCE}';`);
    expect(out.replace(/style-src [^;]+;/, "")).toBe(html.replace(/style-src [^;]+;/, ""));
  });
  test("throws when there is no style-src to extend", () => {
    expect(() => withStyleNonce("<html></html>", DEV_STYLE_NONCE)).toThrow();
  });
});

describe("vite config", () => {
  const resolve = (command: "serve" | "build"): UserConfig => {
    if (typeof viteConfig !== "function") throw new Error("vite.config exports a function");
    const out = viteConfig({ command, mode: command === "serve" ? "development" : "production", isSsrBuild: false, isPreview: false });
    if (out instanceof Promise) throw new Error("vite.config is synchronous");
    return out;
  };
  test("the dev server stamps its injected styles with the dev nonce", () => {
    expect(resolve("serve").html?.cspNonce).toBe(DEV_STYLE_NONCE);
  });
  test("the build sets no nonce: built pages keep style-src 'self' only", () => {
    expect(resolve("build").html?.cspNonce).toBeUndefined();
  });
});
