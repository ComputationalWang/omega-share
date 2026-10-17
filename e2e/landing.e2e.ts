// OME-767 (M9 W1), redesigned as the Dusk doorstep (OME-935): the landing explains the product before asking for
// anything. A skip link, then the nickname form (still the first control) beside the room illustration, then "How it
// works" (three numbered steps) and the install row; the site footer under it all. Desktop: the art sits beside the
// form. Phone: the vignette above it, nothing wider than the screen. Checked keyboard-only, with reduced motion, and
// for layout shift. The perf budget is perf/landing.perf.ts.
import type { Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { site } from "./support/selectors";
import { openDirectory } from "./support/directory";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).boundingBox();
  if (b === null) throw new Error(`no box for ${sel}`);
  return b;
};

/** The hero has decoded (the one file the viewport picked). */
async function heroLoaded(page: Page): Promise<void> {
  const img = page.locator(".entry-art img");
  await expect.poll(() => img.evaluate((e) => e instanceof HTMLImageElement && e.complete && e.naturalWidth > 0)).toBe(true);
}

test("keyboard only: the nickname field has focus on arrival, the skip link is still the first Tab stop, and it moves focus to the page", async ({ page }) => {
  await page.goto(URLS.web);
  // Desktop: the page's one task is focused at once (OME-1280); the skip link stays first in the Tab order.
  await expect(page.locator("#nickname")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const skip = page.locator(".skip-link");
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await expect(skip).toHaveText("Skip to content");
  await page.keyboard.press("Tab");
  await expect(page.locator("#nickname")).toBeFocused();
  // Back to the skip link and follow it: the next Tab starts in <main>, at the nickname field.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator("#nickname")).toBeFocused();
  // Unfocused, the skip link is out of sight.
  await expect(skip).not.toBeInViewport();
  // A click in the page leaves focus on <body>, not on <main> (the room's focus-return rules depend on it).
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test("desktop: the room art sits beside the form at one art pixel per CSS pixel; the steps below; the footer lists every page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(URLS.web);
  await heroLoaded(page);
  const form = await box(page, "#landing");
  const art = await box(page, ".entry-art img");
  expect(art.x).toBeGreaterThanOrEqual(form.x + form.width);
  expect([art.width, art.height]).toEqual([656, 536]);
  const how = await box(page, "#how");
  expect(how.y).toBeGreaterThanOrEqual(form.y + form.height);
  await expect(page.locator("#how")).toContainText("How it works");
  await expect(page.locator(".install")).toContainText("Firefox: coming soon");
  await expect(page.locator(".install")).toContainText("Chrome: coming soon");
  const footer = page.locator(".site-footer");
  for (const name of ["Privacy", "Terms", "Contact", "Licences", "Source", "Feedback"]) await expect(footer.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(footer).toContainText(/version ([0-9a-f]{7}|dev)/);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("the vignette sits above the form, the steps below it, nothing is wider than the screen, and nothing shifts", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as Window & { __cls?: number };
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const shift = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) w.__cls = (w.__cls ?? 0) + shift.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(URLS.web);
    await heroLoaded(page);
    const form = await box(page, "#landing");
    const art = await box(page, ".entry-art");
    expect(art.y + art.height).toBeLessThanOrEqual(form.y);
    expect(art.height).toBe(154);
    const img = await box(page, ".entry-art img");
    expect([img.width, img.height]).toEqual([368, 224]);
    const how = await box(page, "#how");
    expect(how.y).toBeGreaterThanOrEqual(form.y + form.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await page.waitForLoadState("load");
    expect(await page.evaluate(() => (window as Window & { __cls?: number }).__cls ?? 1)).toBeLessThanOrEqual(0.05);
  });

  test("touch: nothing takes focus on arrival, so the keyboard stays down (OME-1280)", async ({ page }) => {
    await page.goto(URLS.web);
    await expect(page.locator(site.nicknameInput)).toBeVisible();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });
});

// OME-1280: the avatar radiogroup moves its selection with the arrow keys (wrapping), Home and End, like a click.
test("keyboard only: arrows, Home and End change the chosen avatar, and the profile saves it", async ({ page }) => {
  await page.goto(URLS.web);
  const options = page.locator(site.avatarOption);
  const chosen = async (i: number): Promise<void> => {
    for (let j = 0; j < 4; j++) {
      await expect(options.nth(j)).toHaveAttribute("aria-checked", String(j === i));
      await expect(options.nth(j)).toHaveAttribute("tabindex", j === i ? "0" : "-1");
    }
    await expect(options.nth(i)).toBeFocused();
  };
  await page.keyboard.type("Arrows");
  await page.keyboard.press("Tab");
  await chosen(0);
  await page.keyboard.press("ArrowRight");
  await chosen(1);
  await page.keyboard.press("ArrowDown");
  await chosen(2);
  await page.keyboard.press("ArrowUp");
  await chosen(1);
  await page.keyboard.press("ArrowLeft");
  await chosen(0);
  await page.keyboard.press("ArrowLeft");
  await chosen(3);
  await page.keyboard.press("ArrowRight");
  await chosen(0);
  await page.keyboard.press("End");
  await chosen(3);
  await page.keyboard.press("Home");
  await chosen(0);
  await page.keyboard.press("ArrowUp");
  await chosen(3);
  // Saved like a click: Find or create a room stores the profile with it.
  await page.locator(site.findRoom).click();
  await expect(page.locator("#home-root")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("omega.avatar"))).toBe("3");
});

test("a nickname error clears as soon as the field is fixed, before the next submit (OME-1280)", async ({ page }) => {
  await page.goto(URLS.web);
  const nickname = page.locator(site.nicknameInput);
  await page.locator(site.findRoom).click();
  await expect(page.locator("#nickname-error")).toHaveText("Pick a nickname.");
  await expect(nickname).toHaveAttribute("aria-invalid", "true");
  await page.keyboard.type("Fixed");
  await expect(page.locator("#nickname-error")).toHaveText("");
  await expect(nickname).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#landing")).toBeVisible();
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("nothing on the landing animates, and every step still reads", async ({ page }) => {
    await page.goto(URLS.web);
    await heroLoaded(page);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await expect(page.locator("#how li")).toHaveCount(3);
    for (const name of ["Find a video", "Share your room", "Watch in sync"]) await expect(page.locator("#how")).toContainText(name);
  });
});

// OME-1022: the create form's preset picker (its chunk and the six thumbnails) is only needed once you head for the
// directory, so a first visit to `/` fetches none of it. Intent in the entry form warms it, and by the time the
// directory opens every thumbnail has its pixels (no pop-in). Dev serves `src/home.ts`, preview `home-<hash>.js`.
const PICKER_URL = /\/(home|presets|preset-thumbs)(-[\w-]+)?\.(js|ts)(\?|$)|\/(classic|cinema|living|lounge|cafe|empty)(-[\w-]+)?\.png(\?|$)/;

test("a first visit to / fetches no preset thumbnails or picker code; intent warms them and the directory shows all six", async ({ page }) => {
  const fetched: string[] = [];
  page.on("request", (r) => {
    if (PICKER_URL.test(new URL(r.url()).pathname)) fetched.push(r.url());
  });
  await page.goto(URLS.web, { waitUntil: "load" });
  await heroLoaded(page);
  // Whatever the page would fetch after `load`, still without input (perf/landing.perf.ts waits as long).
  await page.waitForTimeout(1000);
  expect(fetched, "picker files fetched before any interaction").toEqual([]);
  // The field is focused on arrival (OME-1280), so typing in it is the intent.
  await page.locator(site.nicknameInput).fill("Visitor");
  await expect.poll(() => fetched.length).toBeGreaterThan(0);
  await page.locator(site.findRoom).click();
  const thumbs = page.locator(".preset-picker img");
  await expect(thumbs).toHaveCount(6);
  await expect.poll(() => thumbs.evaluateAll((imgs) => imgs.every((e) => e instanceof HTMLImageElement && e.complete && e.naturalWidth > 0))).toBe(true);
});

test("phone: the entry and directory use 100dvh (100vh as the fallback), and the entry adds no scroll past the screen at 390×664 (OME-1240)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto(URLS.web);
  // Headless Chromium has no URL bar, so vh equals dvh there: read the declared rules (the last valid one wins).
  const heights = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const sel of [".welcome", ".directory"]) {
          if (rule.selectorText === sel) out[sel] = rule.style.minHeight || rule.style.height;
        }
      }
    }
    return out;
  });
  expect(heights).toEqual({ ".welcome": "100dvh", ".directory": "100dvh" });
  // The doorstep's own content is taller than 664 px, so the page scrolls; the min-height must add nothing past the screen.
  const minHeight = await page.locator(".welcome").evaluate((el) => parseFloat(getComputedStyle(el).minHeight));
  expect(minHeight).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
});

// OME-1281 (round-3 audit, OME-1237): the directory's forms. The title error is tied to its input, every Forget key
// names its room, focus never drops to <body> when a row goes, and the armed owner's key fits at 320 px.
test.describe("directory forms", () => {
  const first = "qadirfirst".padEnd(26, "a");
  const second = "qadirsecond".padEnd(26, "a");
  const owned = "qadirowned".padEnd(26, "a");
  /** Saved rooms in this browser before the page loads, oldest first (the list shows the newest first). */
  const seed = async (page: Page, rooms: Record<string, { ownerToken?: string; inviteKey?: string }>): Promise<void> => {
    await page.addInitScript(([k, v]) => {
      localStorage.setItem(k, v);
    }, [ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms })] as const);
  };

  test("an empty submit marks the title invalid and points it at the error; typing clears both", async ({ page }) => {
    await page.goto(URLS.web);
    await openDirectory(page);
    const title = page.locator(site.createRoomTitle);
    await page.locator(site.createRoomSubmit).click();
    await expect(page.locator(site.createRoomError)).not.toBeEmpty();
    const errorId = await page.locator(site.createRoomError).getAttribute("id");
    expect(errorId).toBeTruthy();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(title).toHaveAttribute("aria-describedby", errorId ?? "");
    await title.press("M");
    await expect(title).not.toHaveAttribute("aria-invalid", "true");
    await expect(title).not.toHaveAttribute("aria-describedby", /./);
  });

  test("each Forget key names its room; after a forget focus moves to the next row's key, then to the heading", async ({ page }) => {
    await seed(page, { [first]: { inviteKey: "QaInviteKey-dirfirst".padEnd(22, "y") }, [second]: { inviteKey: "QaInviteKey-dirsecnd".padEnd(22, "y") } });
    await page.goto(URLS.web);
    await openDirectory(page);
    const rows = page.locator(site.yourRoom);
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      const name = (await row.locator(site.yourRoomLink).textContent()) ?? "";
      expect(name).not.toBe("");
      await expect(row.locator(site.yourRoomForget)).toHaveAccessibleName(new RegExp(name));
    }
    await rows.first().locator(site.yourRoomForget).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(site.yourRoomForget)).toBeFocused();
    await rows.first().locator(site.yourRoomForget).press("Enter");
    await expect(rows).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Your rooms" })).toBeFocused();
  });

  test("an owner's armed Forget keeps focus, and the confirmed forget moves it to the next row", async ({ page }) => {
    await seed(page, { [first]: { inviteKey: "QaInviteKey-dirfirst".padEnd(22, "y") }, [owned]: { ownerToken: "QaOwnerToken-dirowned".padEnd(22, "x") } });
    await page.goto(URLS.web);
    await openDirectory(page);
    const rows = page.locator(site.yourRoom);
    const forget = rows.first().locator(site.yourRoomForget);
    await forget.click();
    await expect(forget).toHaveAccessibleName(/for good/);
    await expect(forget).toBeFocused();
    await forget.click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(site.yourRoomForget)).toBeFocused();
  });

  test("at 320 px an owned room's armed Forget key adds no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await seed(page, { [owned]: { ownerToken: "QaOwnerToken-dirowned".padEnd(22, "x") } });
    await page.goto(URLS.web);
    await openDirectory(page);
    const forget = page.locator(site.yourRoomForget);
    await forget.click();
    await expect(forget).toHaveAccessibleName(/for good/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});
