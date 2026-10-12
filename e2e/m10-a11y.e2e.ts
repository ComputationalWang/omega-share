// OME-912 (M10 Q1): the accessibility pass over every NEW M10 surface. One test per surface; axe (wcag2a, wcag2aa,
// wcag21a, wcag21aa, provider iframes excluded, border-image contrast judged by `paintedContrast`) with zero
// violations, the same helper and rule config as m7-a11y.e2e.ts.
//  - W2 (OME-909) portrait dock at 360×740 and 390×844 with touch: at rest, share-link sheet, Up next, Room sheet,
//    People panel, chat sheet; focus moves into a sheet on open, Esc and Close return it to the opener, Tab is
//    trapped (the sheet is a modal <dialog>).
//  - W1 (OME-905) landscape composer, 667×375 full screen with the strip open: "Send" is named and a 44 px target.
//  - W3 (OME-910) create-room form: empty and with a saved layout; fieldset/legend naming, arrow-key selection of each
//    preset, and the chosen preset in the create request (POST /rooms is refused in the page: nothing is created).
//  - W4 (OME-911) the "Away" badge in the People list and the "session moved" card.
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { RESUME_STORAGE_KEY_PREFIX, ROOM_PRESET_IDS } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, ROOT, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
test.setTimeout(90_000);

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const touch = (width: number, height: number) => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) as const;
const id = (name: string): string => `[data-testid="${name}"]`;

let clients: Client[] = [];
let extra: BrowserContext[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  await Promise.all(extra.map((c) => c.close()));
  clients = [];
  extra = [];
});

// axe helper: verbatim from m7-a11y.e2e.ts -----------------------------------------------------------------------------
type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];
const describe = (v: Violation): string => `${v.id} (${v.impact ?? "?"}): ${v.help} | ${v.nodes.map((n) => `${n.target.join(" ")} [${n.any.map((c) => c.message).join(" / ")}]`).join(" ; ")}`;

/**
 * Contrast axe can't compute: our keys and chat lines are painted by `border-image` slices (assets/ui/slices), which axe
 * doesn't read, so it falls back to the page colour behind them (an unreadable 1.06 : 1 on every key and line). For
 * those nodes this reads the slice the way the browser paints it, takes the colour that fills most of its middle, and
 * applies WCAG's own thresholds (4.5 : 1, or 3 : 1 for large text) to the node's text colour. Returns one line per node
 * that really fails, or that has no painted background to read (so it can't be passed by accident).
 */
const paintedContrast = (page: Page, selector: string): Promise<string[]> =>
  page.evaluate(async (sel): Promise<string[]> => {
    const channel = (c: number): number => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb: readonly number[]): number => 0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0);
    const out: string[] = [];
    for (const el of document.querySelectorAll(sel)) {
      let painter: Element | null = el;
      while (painter !== null && getComputedStyle(painter).borderImageSource === "none") painter = painter.parentElement;
      const url = painter === null ? null : /url\("?([^")]+)"?\)/.exec(getComputedStyle(painter).borderImageSource)?.[1];
      if (url === undefined || url === null) {
        out.push(`${sel}: no painted background to read`);
        continue;
      }
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      ctx.drawImage(image, 0, 0);
      const w = Math.max(1, Math.floor(canvas.width * 0.5));
      const h = Math.max(1, Math.floor(canvas.height * 0.5));
      const data = ctx.getImageData(Math.floor(canvas.width * 0.25), Math.floor(canvas.height * 0.25), w, h).data;
      const counts = new Map<string, number>();
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) < 255) continue;
        const k = `${String(data[i])},${String(data[i + 1])},${String(data[i + 2])}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((p, q) => q[1] - p[1])[0];
      if (top === undefined) {
        out.push(`${sel}: the painted background has no opaque middle`);
        continue;
      }
      const bg = top[0].split(",").map(Number);
      const cs = getComputedStyle(el);
      const fg = (cs.color.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((p, q) => q - p);
      const ratio = ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
      const px = parseFloat(cs.fontSize);
      const need = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700) ? 3 : 4.5;
      if (ratio < need) out.push(`${sel}: text rgb(${fg.join(",")}) on painted rgb(${bg.join(",")}) is ${ratio.toFixed(2)} : 1, needs ${String(need)} : 1`);
    }
    return out;
  }, selector);

/**
 * Runs axe over the page's own document. Provider iframes are excluded: they are the third party's documents (the
 * player's own markup), not ours; the frame element itself is covered by our `title`. Contrast on border-image
 * backgrounds is judged by `paintedContrast` instead of axe's blind guess.
 */
async function violations(page: Page, ignore: readonly string[] = []): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).exclude("iframe").analyze();
  const out: string[] = [];
  // `ignore` is for known product bugs that have a test.fail of their own; everything else must be zero.
  const seen = result.violations.filter((v) => !ignore.includes(v.id));
  for (const v of seen) {
    if (v.id !== "color-contrast") {
      out.push(describe(v));
      continue;
    }
    for (const n of v.nodes) {
      const [selector] = n.target;
      if (typeof selector === "string") out.push(...(await paintedContrast(page, selector)));
      else out.push(`color-contrast: ${n.target.join(" ")} (inside a shadow root or frame)`);
    }
  }
  return out;
}

// W2: portrait dock ----------------------------------------------------------------------------------------------------

const SHEET = id("portrait-sheet");

/** Opens `opener`'s sheet and checks focus went inside it, the sheet is modal, and Tab / Shift+Tab never leave it. */
async function expectModalSheet(page: Page, opener: Locator, label: string): Promise<void> {
  const sheet = page.locator(SHEET);
  await opener.click();
  await expect(sheet, label).toBeVisible();
  expect(await sheet.evaluate((el) => el.matches(":modal")), `${label}: modal`).toBe(true);
  expect(await sheet.evaluate((el) => el.contains(document.activeElement)), `${label}: focus moved into the sheet`).toBe(true);
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press(key);
      expect(await sheet.evaluate((el) => el.contains(document.activeElement)), `${label}: ${key} #${String(i)} stays inside`).toBe(true);
    }
  }
}

for (const [width, height] of [[360, 740], [390, 844]] as const) {
  test(`${String(width)}×${String(height)} portrait dock: zero axe violations at rest and with each sheet open; focus enters, traps and returns`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("m10-a11y", width === 360 ? "dock360" : "dock390").url, count: 1, nicknamePrefix: `ax${String(width)}`, contextOptions: () => touch(width, height) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    const sheet = page.locator(SHEET);
    await expect(page.locator("#room-root")).toHaveClass(/room-portrait/);
    expect(await violations(page), "at rest").toEqual([]);

    // People: the room bar's panel (inline in portrait, not a sheet).
    await page.locator(site.peopleKey).click();
    await expect(page.locator(site.peoplePanel)).toBeVisible();
    expect(await violations(page), "People open").toEqual([]);
    await page.locator(site.peopleKey).click();
    await expect(page.locator(site.peoplePanel)).toBeHidden();

    const sheets: readonly (readonly [string, Locator])[] = [
      ["share-link sheet (Link)", page.locator(id("portrait-link"))],
      ["Up next sheet", page.locator(id("portrait-queue"))],
      ["Room sheet", page.locator(id("portrait-settings"))],
      ["chat sheet", page.locator(id("portrait-chat"))],
    ];
    for (const [label, opener] of sheets) {
      await expectModalSheet(page, opener, label);
      await expect(sheet, `${label}: has a name`).toHaveAttribute("aria-label", /\S/);
      expect(await violations(page), `${label}: axe`).toEqual([]);
      // Esc returns focus to the opener, and so does the Close key.
      await page.keyboard.press("Escape");
      await expect(sheet, `${label}: Esc closes`).toBeHidden();
      await expect(opener, `${label}: Esc returns focus`).toBeFocused();
      await opener.click();
      await expect(sheet).toBeVisible();
      await page.locator(id("portrait-sheet-close")).click();
      await expect(sheet, `${label}: Close closes`).toBeHidden();
      await expect(opener, `${label}: Close returns focus`).toBeFocused();
    }
    expect(await violations(page), "after the sheets").toEqual([]);
  });
}

// W1: landscape composer -----------------------------------------------------------------------------------------------

test("667×375 full screen, strip open: zero axe violations; the send key is named and a 44 px target", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("m10-a11y", "fs").url, count: 1, nicknamePrefix: "axfs", contextOptions: () => touch(667, 375) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await page.locator(site.fullscreenToggle).click();
  const strip = page.locator(site.fsStrip);
  await expect(strip).toHaveAttribute("data-strip", "open");
  const send = strip.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeVisible();
  const b = await send.boundingBox();
  expect(b?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(b?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await violations(page), "strip open").toEqual([]);
});

// W3: create-room form -------------------------------------------------------------------------------------------------

const SAVED_KEY = "omega.savedLayouts.v1";
const radio = (preset: string): string => id(`preset-${preset}`);

async function openHome(browser: Browser, saved: boolean): Promise<{ page: Page; created: () => readonly unknown[] }> {
  const context = await watchCsp(await browser.newContext());
  extra.push(context);
  await stubExternalNetwork(context);
  // The create request is captured and refused: nothing reaches the shared server (it limits creates to 2 per 10 min).
  const bodies: unknown[] = [];
  await context.route(`${URLS.server}/rooms`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(`${URLS.web}/`);
  if (saved) {
    const layout: unknown = JSON.parse(readFileSync(join(ROOT, "assets/presets/classic.json"), "utf8"));
    await page.evaluate(([key, value]) => { localStorage.setItem(key ?? "", value ?? ""); }, [SAVED_KEY, JSON.stringify([{ name: "Mine", layout }])]);
    await page.reload();
  }
  await expect(page.locator(site.createRoomForm)).toBeVisible();
  return { page, created: () => bodies };
}

test("create-room form, empty: zero axe violations; the picker is a named group; arrows select each preset and it reaches the request", async ({ browser }) => {
  const { page, created } = await openHome(browser, false);
  expect(await violations(page), "empty form").toEqual([]);
  const picker = page.locator(id("preset-picker"));
  expect(await picker.evaluate((el) => el.tagName === "FIELDSET" && (el.querySelector(":scope > legend")?.textContent ?? "").trim() !== "")).toBe(true);
  await expect(page.getByRole("group", { name: "Room layout" })).toBeVisible();
  const ids = await page.locator(`${id("preset-picker")} input[type=radio]`).evaluateAll((rs) => rs.map((r) => (r instanceof HTMLInputElement ? r.value : "")));
  expect([...ids].sort()).toEqual([...ROOM_PRESET_IDS].sort());
  // Keyboard only: ArrowRight from the checked radio walks the group, checking each in turn.
  await page.locator(radio("classic")).focus();
  await expect(page.locator(radio("classic"))).toBeChecked();
  const seen = ["classic"];
  for (let i = 1; i < ids.length; i++) {
    await page.keyboard.press("ArrowRight");
    const now = await page.evaluate(() => (document.activeElement instanceof HTMLInputElement ? document.activeElement.value : ""));
    expect(await page.locator(radio(now)).isChecked(), `${now} is checked when focused`).toBe(true);
    seen.push(now);
  }
  expect([...seen].sort(), "arrows reach every preset").toEqual([...ids].sort());
  for (const [n, preset] of ids.entries()) {
    await page.locator(radio(preset)).focus();
    await page.keyboard.press("Space");
    await expect(page.locator(radio(preset))).toBeChecked();
    await page.locator(site.createRoomTitle).fill(`R ${preset}`);
    await page.locator(site.createRoomTitle).press("Enter");
    await expect.poll(() => created().length).toBe(n + 1);
    expect(created()[n]).toMatchObject({ preset });
    // The refused request shows the network error and the form is usable again.
    await expect(page.locator(site.createRoomSubmit)).toBeEnabled();
  }
  expect(await violations(page), "after selecting").toEqual([]);
});

test("create-room form with a saved layout offered: zero axe violations; named groups; the saved radio is in the keyboard group and sends the empty preset", async ({ browser }) => {
  const { page, created } = await openHome(browser, true);
  await expect(page.locator(id("saved-layouts"))).toContainText("Mine");
  await expect(page.getByRole("group", { name: "Your layouts" })).toBeVisible();
  expect(await violations(page), "saved layout offered").toEqual([]);
  const saved = page.locator(id("saved-layout-radio"));
  await expect(saved).toHaveAccessibleName(/Mine/);
  // The presets and the saved layout are one `name="preset"` group: ArrowRight from the last preset lands on it.
  const last = await page.locator(`${id("preset-picker")} input[type=radio]`).last().evaluate((r) => (r instanceof HTMLInputElement ? r.value : ""));
  await page.locator(radio(last)).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(saved).toBeFocused();
  await expect(saved).toBeChecked();
  await page.locator(site.createRoomTitle).fill("Saved one");
  await page.locator(site.createRoomTitle).press("Enter");
  await expect.poll(() => created().length).toBe(1);
  expect(created()[0]).toMatchObject({ preset: "empty", title: "Saved one" });
  expect(await violations(page), "after choosing the saved layout").toEqual([]);
});

// W4: durable sessions -------------------------------------------------------------------------------------------------

/** How the page looks to lifecycle code while it is in the background (m10-sessions.e2e.ts). */
async function goAway(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
}

test("the Away badge in the People list: zero axe violations on a peer's view", async ({ browser }) => {
  const room = testRoom("m10-a11y", "away");
  clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "axaway", contextOptions: (i) => (i === 0 ? touch(390, 844) : { viewport: { width: 1280, height: 720 } }) });
  const [gone, peer] = clients;
  if (gone === undefined || peer === undefined) throw new Error("no clients");
  await goAway(gone.page);
  const row = peer.page.locator(`${site.peopleRow}.is-away`).filter({ hasText: gone.nickname });
  await expect(row).toHaveCount(1);
  await peer.page.locator(site.peopleKey).click();
  await expect(peer.page.locator(site.peoplePanel)).toBeVisible();
  await expect(row.getByText("Away", { exact: true })).toBeVisible();
  expect(await violations(peer.page), "Away badge").toEqual([]);
});

test("the session-moved card: zero axe violations; its Return key is a named button", async ({ browser }) => {
  const room = testRoom("m10-a11y", "moved");
  clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "axmoved", contextOptions: () => touch(390, 844) });
  const first = clients[0];
  if (first === undefined) throw new Error("no client");
  const key = `${RESUME_STORAGE_KEY_PREFIX}${room.id}`;
  const record = await first.page.evaluate((k) => sessionStorage.getItem(k), key);
  expect(record).not.toBeNull();
  // A second tab carrying the same session (as a duplicated tab would): the first tab is told it moved.
  const twin = await first.context.newPage();
  await twin.addInitScript(([k, v]) => {
    if (sessionStorage.getItem(k ?? "") === null) sessionStorage.setItem(k ?? "", v ?? "");
  }, [key, record ?? ""]);
  await twin.goto(room.url);
  const card = first.page.locator(id("room-replaced"));
  await expect(card).toBeVisible();
  await expect(card.locator(id("room-replaced-return"))).toHaveAccessibleName(/\S/);
  expect(await violations(first.page), "session moved").toEqual([]);
});
