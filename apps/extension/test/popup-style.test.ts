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
