// OME-767 (M9 W1): the landing explains the product before asking for anything. A skip link, then the nickname form
// (still the first control), then "How it works" (three D1 panels) and the install row; the site footer under it all.
// Desktop: the steps sit beside the form. Phone: below it, nothing wider than the screen. Checked keyboard-only, with
// reduced motion, and for layout shift while the lazy panels arrive. The perf budget is perf/landing.perf.ts.
import type { Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).boundingBox();
  if (b === null) throw new Error(`no box for ${sel}`);
  return b;
};

/** Every panel has decoded: lazy images below the fold are scrolled into view first. */
async function panelsLoaded(page: Page): Promise<void> {
  const imgs = page.locator("#how img");
  await expect(imgs).toHaveCount(3);
  for (const img of await imgs.all()) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((e) => e instanceof HTMLImageElement && e.complete && e.naturalWidth === 368)).toBe(true);
  }
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

test("desktop: 'How it works' sits beside the form, its panels at one art pixel per CSS pixel; the footer lists every page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(URLS.web);
  await panelsLoaded(page);
  const form = await box(page, "#landing");
  const how = await box(page, "#how");
  expect(how.x).toBeGreaterThanOrEqual(form.x + form.width);
  expect(how.y).toBeLessThan(form.y + form.height);
  const img = await box(page, "#how li:first-child img");
  expect([img.width, img.height]).toEqual([184, 112]);
  await expect(page.locator("#how")).toContainText("How it works");
  await expect(page.locator(".install")).toContainText("Firefox: coming soon");
  await expect(page.locator(".install")).toContainText("Chrome: coming soon");
  const footer = page.locator(".site-footer");
  for (const name of ["Privacy", "Terms", "Contact", "Licences", "Source", "Feedback"]) await expect(footer.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(footer).toContainText(/version ([0-9a-f]{7}|dev)/);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("the steps come below the form, nothing is wider than the screen, and the lazy panels shift nothing", async ({ page }) => {
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
    await panelsLoaded(page);
    const form = await box(page, "#landing");
    const how = await box(page, "#how");
    expect(how.y).toBeGreaterThanOrEqual(form.y + form.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    for (const img of await page.locator("#how img").all()) {
      const b = await img.boundingBox();
      expect([b?.width, b?.height]).toEqual([184, 112]);
    }
    expect(await page.evaluate(() => (window as Window & { __cls?: number }).__cls ?? 1)).toBeLessThanOrEqual(0.05);
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("nothing on the landing animates, and every step still reads", async ({ page }) => {
    await page.goto(URLS.web);
    await panelsLoaded(page);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await expect(page.locator("#how li")).toHaveCount(3);
    for (const name of ["The extension finds the video", "Share it into a room", "Sit together and watch"]) await expect(page.locator("#how")).toContainText(name);
  });
});
