import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const popupDir = new URL("../src/entrypoints/popup/", import.meta.url);
const html = readFileSync(new URL("index.html", popupDir), "utf8");
const css = readFileSync(new URL("style.css", popupDir), "utf8");

function renderPopup(): Window {
  const window = new Window({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  window.document.write(html.replace(/<link[^>]*>/, `<style>${css}</style>`));
  return window;
}

function shareForm(window: Window) {
  const form = window.document.getElementById("share-form");
  if (!(form instanceof window.HTMLElement)) throw new Error("share-form missing");
  return form;
}

describe("popup stylesheet", () => {
  test("the share form is not displayed while it is hidden (scanning, no embeds, unreadable tab)", () => {
    const window = renderPopup();
    const form = shareForm(window);
    expect(form.hidden).toBe(true);
    expect(window.getComputedStyle(form).display).toBe("none");
  });

  test("the share form lays out as flex once it is shown", () => {
    const window = renderPopup();
    const form = shareForm(window);
    form.hidden = false;
    expect(window.getComputedStyle(form).display).toBe("flex");
  });
});

// OME-842 art (assets/ui/popup/): a 48×40 decorative vignette above each state line; the line carries the meaning.
describe("popup state vignettes (OME-857)", () => {
  const vignettes = [
    { state: "empty", art: "nothing-found", line: "No supported video found on this page." },
    { state: "unreadable", art: "cant-read", line: "Can't read this tab. Open a regular web page and try again." },
    { state: "server-status", art: "server-away", line: "" },
  ] as const;

  for (const { state, art, line } of vignettes) {
    test(`#${state} shows ${art} at 1× and 2×, decorative, pixelated, above the line`, () => {
      const window = renderPopup();
      const el = window.document.getElementById(state);
      const img = el?.querySelector("img");
      if (el === null || img === null || img === undefined) throw new Error(`#${state} has no vignette`);
      expect(el.firstElementChild).toBe(img);
      expect(img.getAttribute("src")).toBe(`/popup/${art}.png`);
      expect(img.getAttribute("srcset")).toBe(`/popup/${art}.png 1x, /popup/${art}@2x.png 2x`);
      expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["48", "40"]);
      expect(img.getAttribute("alt")).toBe("");
      img.hidden = false; // the server-away one is only shown while the server is away
      expect(window.getComputedStyle(img).imageRendering).toBe("pixelated");
      expect(window.getComputedStyle(img).display).toBe("block");
      expect(el.textContent.trim()).toBe(line);
    });
  }

  test("the server-away vignette is hidden until the server is away, and the status text has its own node", () => {
    const window = renderPopup();
    const img = window.document.getElementById("server-away");
    if (!(img instanceof window.HTMLImageElement)) throw new Error("#server-away missing");
    expect(img.hidden).toBe(true);
    expect(window.getComputedStyle(img).display).toBe("none");
    expect(window.document.getElementById("server-message")?.parentElement?.id).toBe("server-status");
  });
});
