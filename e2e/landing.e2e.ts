// OME-767 (M9 W1), redesigned as the Dusk doorstep (OME-935): the landing explains the product before asking for
// anything. A skip link, then the nickname form (still the first control) beside the room illustration, then "How it
// works" (three numbered steps) and the install row; the site footer under it all. Desktop: the art sits beside the
// form. Phone: the vignette above it, nothing wider than the screen. Checked keyboard-only, with reduced motion, and
// for layout shift. The perf budget is perf/landing.perf.ts.
import type { Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { site } from "./support/selectors";

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

test("keyboard only: the skip link comes first, then the nickname field, and the skip link moves focus to the page", async ({ page }) => {
  await page.goto(URLS.web);
  await page.keyboard.press("Tab");
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
  await page.locator(site.nicknameInput).focus();
  await expect.poll(() => fetched.length).toBeGreaterThan(0);
  await page.locator(site.nicknameInput).fill("Visitor");
  await page.locator(site.findRoom).click();
  const thumbs = page.locator(".preset-picker img");
  await expect(thumbs).toHaveCount(6);
  await expect.poll(() => thumbs.evaluateAll((imgs) => imgs.every((e) => e instanceof HTMLImageElement && e.complete && e.naturalWidth > 0))).toBe(true);
});
