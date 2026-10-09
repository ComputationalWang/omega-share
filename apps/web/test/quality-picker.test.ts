import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PlaybackView } from "../src/controls/playback";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-599, set (k) `ui-m7-quality`: a personal key at the end of the shelf, before full screen. It opens the moderation
// menu's tray (role=menu, menuitemradio rows) under the shelf, or as a row in place of the shelf's contents in full screen.
// No key at all where the player can't be set (YouTube, generic, Vimeo without a paid owner).

const LIST = [
  { id: "auto", label: "Auto" },
  { id: "chunked", label: "1080p60 (source)" },
  { id: "720p60", label: "720p60" },
  { id: "480p30", label: "480p" },
];

const base: PlaybackView = {
  hasVideo: true,
  canControl: true,
  playing: true,
  position: 30,
  duration: 200,
  volume: 100,
  muted: false,
  needsUnmute: false,
  catching: false,
  error: null,
  provider: "twitch",
  live: false,
  seekOnly: true,
  policy: "everyone",
  held: false,
  qualities: LIST,
  quality: "auto",
};

async function setup() {
  const { createQualityPicker, QUALITY_SWITCH_MS } = await import("../src/controls/quality-picker");
  const picked: string[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const p = createQualityPicker(
    {
      setQuality: (id) => {
        picked.push(id);
      },
    },
    {
      setTimeout: (fn, ms) => {
        const h = { fn, ms, cleared: false };
        timers.push(h);
        return h;
      },
      clearTimeout: (h) => {
        h.cleared = true;
      },
    },
  );
  const shelf = document.createElement("div");
  shelf.append(p.key);
  document.body.replaceChildren(shelf, p.menu);
  const rows = () => [...p.menu.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")];
  const press = (target: HTMLElement, key: string) => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  };
  const fire = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
  };
  return { p, picked, timers, rows, press, fire, QUALITY_SWITCH_MS };
}

describe("quality picker (only you)", () => {
  test("no list → no key at all (YouTube, generic, a refused Vimeo set): no disabled control, no hint", async () => {
    const { p } = await setup();
    p.update({ ...base, qualities: [], quality: null });
    expect(p.key.hidden).toBe(true);
    expect(p.menu.hidden).toBe(true);
  });

  test("a list → the key: a personal icon key that opens a menu and says what's playing", async () => {
    const { p } = await setup();
    p.update(base);
    expect(p.key.hidden).toBe(false);
    expect(p.key.classList.contains("self")).toBe(true);
    expect(p.key.querySelector(".ui-icon-quality")).not.toBeNull();
    expect(p.key.getAttribute("aria-haspopup")).toBe("menu");
    expect(p.key.getAttribute("aria-expanded")).toBe("false");
    expect(p.key.ariaLabel).toBe("Quality: Auto. Only you.");
    p.update({ ...base, quality: null });
    expect(p.key.ariaLabel).toBe("Quality. Only you.");
  });

  test("the key opens the menu: head, one menuitemradio per option, the current one checked and focused, the foot", async () => {
    const { p, rows } = await setup();
    p.update({ ...base, quality: "720p60" });
    p.key.click();
    expect(p.menu.hidden).toBe(false);
    expect(p.menu.getAttribute("role")).toBe("menu");
    expect(p.menu.ariaLabel).toBe("Quality, only you");
    expect(p.menu.classList.contains("ui-qmenu")).toBe(true);
    expect(p.key.getAttribute("aria-expanded")).toBe("true");
    expect(rows().map((r) => r.textContent)).toEqual(["Auto", "1080p60 (source)", "720p60", "480p"]);
    expect(rows().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    expect(document.activeElement).toBe(rows()[2] ?? null);
    expect(p.menu.textContent).toContain("Only on this device.");
  });

  test("keyboard: ↓ on the key opens it; ↓/↑ move (wrapping); Enter picks and the menu stays open; Esc closes onto the key", async () => {
    const { p, rows, press, picked } = await setup();
    p.update(base);
    press(p.key, "ArrowDown");
    expect(p.isOpen()).toBe(true);
    expect(document.activeElement).toBe(rows()[0] ?? null);
    press(rows()[0] ?? p.menu, "ArrowUp");
    expect(document.activeElement).toBe(rows()[3] ?? null);
    press(rows()[3] ?? p.menu, "ArrowDown");
    press(rows()[0] ?? p.menu, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1] ?? null);
    rows()[1]?.click();
    expect(picked).toEqual(["chunked"]);
    expect(p.isOpen()).toBe(true);
    press(rows()[1] ?? p.menu, "Escape");
    expect(p.isOpen()).toBe(false);
    expect(document.activeElement).toBe(p.key);
  });

  test("a pick ticks at once and the key shows the switch (is-switching, aria-busy, wait dial) for the echo window", async () => {
    const { p, rows, picked, timers, fire, QUALITY_SWITCH_MS } = await setup();
    p.update(base);
    p.key.click();
    rows()[3]?.click();
    expect(picked).toEqual(["480p30"]);
    expect(rows()[3]?.getAttribute("aria-checked")).toBe("true");
    expect(p.key.classList.contains("is-switching")).toBe(true);
    expect(p.key.getAttribute("aria-busy")).toBe("true");
    expect(p.key.ariaLabel).toBe("Quality: switching to 480p. Only you.");
    expect(p.key.querySelector(".ui-wait")).not.toBeNull();
    expect(timers.map((t) => t.ms)).toEqual([QUALITY_SWITCH_MS]);
    fire();
    p.update({ ...base, quality: "480p30" });
    expect(p.key.classList.contains("is-switching")).toBe(false);
    expect(p.key.getAttribute("aria-busy")).toBeNull();
    expect(p.key.ariaLabel).toBe("Quality: 480p. Only you.");
  });

  test("picking the quality that's already on does nothing", async () => {
    const { p, rows, picked } = await setup();
    p.update(base);
    p.key.click();
    rows()[0]?.click();
    expect(picked).toEqual([]);
  });

  test("a click outside closes it; so does the key again", async () => {
    const { p } = await setup();
    p.update(base);
    p.key.click();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(p.isOpen()).toBe(false);
    p.key.click();
    p.key.click();
    expect(p.isOpen()).toBe(false);
  });

  test("the list going away (a rejected Vimeo set) closes the menu and hides the key", async () => {
    const { p } = await setup();
    p.update(base);
    p.key.click();
    p.update({ ...base, qualities: [], quality: null });
    expect(p.isOpen()).toBe(false);
    expect(p.key.hidden).toBe(true);
  });

  test("row mode (full screen): the menu is a row with no tail, ←/→ move, and it has its own close key", async () => {
    const { p, rows, press } = await setup();
    p.setRow(true);
    p.update(base);
    p.key.click();
    expect(p.menu.classList.contains("is-row")).toBe(true);
    expect(p.menu.classList.contains("is-below")).toBe(false);
    expect(document.activeElement).toBe(rows()[0] ?? null);
    press(rows()[0] ?? p.menu, "ArrowRight");
    expect(document.activeElement).toBe(rows()[1] ?? null);
    press(rows()[1] ?? p.menu, "ArrowLeft");
    expect(document.activeElement).toBe(rows()[0] ?? null);
    p.menu.querySelector<HTMLButtonElement>("[data-testid=quality-close]")?.click();
    expect(p.isOpen()).toBe(false);
    expect(document.activeElement).toBe(p.key);
    p.setRow(false);
    p.key.click();
    expect(p.menu.classList.contains("is-below")).toBe(true);
  });

  test("Tab out of the menu closes it", async () => {
    const { p, rows } = await setup();
    p.update(base);
    p.key.click();
    rows()[0]?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    expect(p.isOpen()).toBe(false);
  });

  test("labels go in as text, never markup", async () => {
    const { p, rows } = await setup();
    p.update({ ...base, qualities: [{ id: "x", label: "<img src=x onerror=alert(1)>" }], quality: null });
    p.key.click();
    expect(rows()[0]?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(p.menu.querySelector("img")).toBeNull();
  });
});

describe("quality picker in browsers that don't focus a button on press (OME-599 review)", () => {
  test("a press on a row blurs it with no relatedTarget (Safari, macOS Firefox): the menu stays open and the click picks", async () => {
    const { p, rows, picked } = await setup();
    p.update(base);
    p.key.click();
    const r = rows()[2];
    if (r === undefined) throw new Error("no row");
    r.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    rows()[0]?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(p.isOpen()).toBe(true);
    r.click();
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(picked).toEqual(["720p60"]);
    // Once the press is over, focus leaving closes it again.
    r.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(p.isOpen()).toBe(false);
  });
});
