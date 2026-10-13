import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const popupDir = new URL("../src/entrypoints/popup/", import.meta.url);
const html = readFileSync(new URL("index.html", popupDir), "utf8");
const css = readFileSync(new URL("style.css", popupDir), "utf8");
// The OME-1041 popup kit, copied into the build as /popup/kit.css (wxt.config.ts).
const kitCss = readFileSync(new URL("../../../assets/ui/popup/kit.css", import.meta.url), "utf8");

/** The popup with both stylesheets inlined in their link order: the kit, then the popup's own rules. */
function renderPopup(): Window {
  const window = new Window({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  window.document.write(html.replace(/<link[^>]*href="\/popup\/kit\.css"[^>]*>/, `<style>${kitCss}</style>`).replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${css}</style>`));
  return window;
}

function byId(window: Window, id: string) {
  const el = window.document.getElementById(id);
  if (!(el instanceof window.HTMLElement)) throw new Error(`#${id} missing`);
  return el;
}

describe("popup stylesheet", () => {
  test("loads the popup kit before its own rules", () => {
    const kit = html.indexOf('href="/popup/kit.css"');
    expect(kit).toBeGreaterThan(-1);
    expect(kit).toBeLessThan(html.indexOf('href="./style.css"'));
  });

  test("the share form is not displayed while it is hidden (scanning, no embeds, unreadable tab)", () => {
    const window = renderPopup();
    const form = byId(window, "share-form");
    expect(form.hidden).toBe(true);
    expect(window.getComputedStyle(form).display).toBe("none");
  });

  test("the share form lays out as a grid once it is shown", () => {
    const window = renderPopup();
    const form = byId(window, "share-form");
    form.hidden = false;
    expect(window.getComputedStyle(form).display).toBe("grid");
  });
});

// OME-1041 popup kit (assets/README.md § Set (o)): one wood panel on the plum page, the site's chrome.
describe("popup kit markup (OME-1043)", () => {
  test("the popup is one wood panel on the plum page, 340 px wide", () => {
    const window = renderPopup();
    expect(window.document.body.classList.contains("pk")).toBe(true);
    const main = window.document.querySelector("main");
    expect(main?.classList.contains("ui-panel")).toBe(true);
    expect(main?.classList.contains("pk-main")).toBe(true);
    expect(window.getComputedStyle(window.document.body).width).toBe("340px");
  });

  test("the head carries the TV icon, the title and an empty host slot", () => {
    const window = renderPopup();
    const head = window.document.querySelector("h1.pk-head");
    expect(head?.querySelector(".pk-sprite.pk-icon-tv")?.getAttribute("aria-hidden")).toBe("true");
    expect(head?.textContent.trim()).toBe("Share a video");
    expect(byId(window, "host").classList.contains("host")).toBe(true);
  });

  test("scanning shows the animated dots over its line", () => {
    const window = renderPopup();
    const scanning = byId(window, "scanning");
    expect(scanning.classList.contains("pk-state")).toBe(true);
    expect(scanning.getAttribute("role")).toBe("status");
    expect(scanning.firstElementChild?.className).toBe("pk-sprite pk-glyph-dots-0 ui-dots");
    expect(scanning.textContent.trim()).toBe("Looking for videos…");
  });

  test("the embeds list is a fieldset with its legend, inside the share form", () => {
    const window = renderPopup();
    const list = byId(window, "embeds");
    const fieldset = list.closest("fieldset");
    expect(fieldset?.classList.contains("pk-list")).toBe(true);
    expect(fieldset?.querySelector("legend")?.textContent).toBe("Videos on this page");
    expect(fieldset?.closest("form")?.id).toBe("share-form");
  });

  test("the room picker is a night field with the chevron", () => {
    const window = renderPopup();
    const room = byId(window, "room");
    expect(room.classList.contains("ui-input")).toBe(true);
    const field = room.parentElement;
    expect(field?.classList.contains("pk-field")).toBe(true);
    expect(field?.querySelector(".pk-sprite.pk-chevron")?.getAttribute("aria-hidden")).toBe("true");
    expect(field?.parentElement?.classList.contains("pk-room")).toBe(true);
  });

  test("Share is the mustard key and Add to queue the navy one, each with its icon", () => {
    const window = renderPopup();
    const share = byId(window, "share");
    const queue = byId(window, "queue");
    expect(share.className).toBe("ui-button");
    expect(queue.className).toBe("ui-button secondary");
    expect(share.querySelector(".pk-icon-share")).not.toBeNull();
    expect(queue.querySelector(".pk-icon-queue-add")).not.toBeNull();
    expect([share.textContent.trim(), queue.textContent.trim()]).toEqual(["Share", "Add to queue"]);
    expect(share.parentElement?.classList.contains("pk-keys")).toBe(true);
  });

  test("Server settings and the legal links sit in the foot", () => {
    const window = renderPopup();
    const options = byId(window, "options");
    expect(options.classList.contains("pk-link")).toBe(true);
    expect(options.closest("footer")?.classList.contains("pk-foot")).toBe(true);
    expect(window.document.querySelector('[data-testid="legal-links"]')?.closest("footer.pk-foot")).not.toBeNull();
  });
});

// OME-842 art (assets/ui/popup/): a decorative vignette above each state line; the line carries the meaning.
describe("popup state vignettes (OME-857)", () => {
  const vignettes = [
    { state: "empty", art: "nothing-found", line: "No supported video found on this page." },
    { state: "unreadable", art: "cant-read", line: "Can't read this tab. Open a regular web page and try again." },
    { state: "server-status", art: "server-away", line: "" },
  ] as const;

  for (const { state, art, line } of vignettes) {
    test(`#${state} is a kit state with ${art} at 1× and 2×, decorative, pixelated, above the line`, () => {
      const window = renderPopup();
      const el = byId(window, state);
      const img = el.querySelector("img");
      if (img === null) throw new Error(`#${state} has no vignette`);
      expect(el.classList.contains("pk-state")).toBe(true);
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
    const img = byId(window, "server-away");
    expect(img.hidden).toBe(true);
    expect(window.getComputedStyle(img).display).toBe("none");
    expect(window.document.getElementById("server-message")?.parentElement?.id).toBe("server-status");
  });
});

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

function token(name: string): string {
  const m = new RegExp(`--ui-${name}:\\s*(#[0-9a-f]{6})`).exec(kitCss);
  if (m?.[1] === undefined) throw new Error(`--ui-${name} missing`);
  return m[1];
}

// Acceptance (OME-1043): text contrast is AA (4.5:1) for every text colour on the surface it is drawn on.
describe("popup text contrast is WCAG AA", () => {
  const pairs = [
    ["text", "panel"],
    ["muted", "panel"],
    ["hint", "panel"],
    ["error", "panel"],
    ["accent", "panel"],
    ["glow", "panel"],
    ["text", "field"],
    ["on-primary", "accent"],
    ["text", "page"],
  ] as const;
  for (const [fg, bg] of pairs) {
    test(`--ui-${fg} on --ui-${bg}`, () => {
      expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
