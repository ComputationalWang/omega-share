import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

// The hosted site (`HOSTED_SERVER_BASE_URL` in src/settings.ts). Legal links never follow the user's configured server.
const PRODUCTION_ORIGIN = "https://omega-share.duckdns.org";
const EXPECTED = [
  { text: "Privacy", href: `${PRODUCTION_ORIGIN}/privacy.html#extension` },
  { text: "Terms", href: `${PRODUCTION_ORIGIN}/terms.html` },
  { text: "Licences", href: `${PRODUCTION_ORIGIN}/licenses.html` },
];

const entrypoints = new URL("../src/entrypoints/", import.meta.url);
const popupHtml = readFileSync(new URL("popup/index.html", entrypoints), "utf8");
const popupCss = readFileSync(new URL("popup/style.css", entrypoints), "utf8");
const optionsHtml = readFileSync(new URL("options/index.html", entrypoints), "utf8");

function render(html: string): Window {
  const window = new Window({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  window.document.write(html.replace(/<link[^>]*>/, `<style>${popupCss}</style>`));
  return window;
}

/** The body of the `@media (hover: none)` block in a stylesheet. */
function hoverNoneRules(css: string): string {
  const start = css.indexOf("@media (hover: none)");
  if (start === -1) throw new Error("no hover:none block");
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i);
  }
  throw new Error("unterminated hover:none block");
}

const pages = [
  { name: "popup", html: popupHtml, css: popupCss },
  { name: "options", html: optionsHtml, css: optionsHtml },
];

describe.each(pages)("$name legal footer", ({ html, css }) => {
  test("links Privacy (extension section), Terms and Licences on the production site", () => {
    const window = render(html);
    const links = [...window.document.querySelectorAll('[data-testid="legal-links"] a')];
    expect(links.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute("href") }))).toEqual(EXPECTED);
  });

  test("each link opens in a new tab without referrer or opener", () => {
    const window = render(html);
    const links = [...window.document.querySelectorAll('[data-testid="legal-links"] a')];
    expect(links.length).toBe(EXPECTED.length);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect((a.getAttribute("rel") ?? "").split(/\s+/).sort()).toEqual(["noopener", "noreferrer"]);
    }
  });

  test("links are 44 px touch targets under hover:none", () => {
    expect(hoverNoneRules(css)).toMatch(/\.legal a\s*\{[^}]*min-height:\s*44px/);
  });
});

test("the popup keeps its 320 px width", () => {
  const window = render(popupHtml);
  expect(window.getComputedStyle(window.document.body).width).toBe("320px");
});
