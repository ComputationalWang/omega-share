// OME-1299: the legal pages get the landing's skip link (first Tab stop; focus moves into <main> and the next Tab goes on
// in the page), and none of them scrolls sideways on a 320px phone (QA OME-1300 F6, WCAG 1.4.10).
import { expect, test } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";

test.fixme(!available.web, PENDING.web);

const PAGES = ["terms", "privacy", "licenses", "contact"] as const;

for (const name of PAGES) {
  test(`${name}: the skip link is the first Tab stop, moves focus to the heading, and the next Tab continues in the page`, async ({ page }) => {
    await page.goto(`${URLS.web}/${name}.html`);
    const skip = page.locator(".skip-link");
    await expect(skip).not.toBeInViewport();
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await expect(skip).toHaveText("Skip to content");
    // Readable: the page's link colour (.privacy a) must not paint the text in the link's own background (QA OME-1310).
    const [fg, bg] = await skip.evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
    expect(fg).not.toBe(bg);
    await page.keyboard.press("Enter");
    // The target is the page's heading: the link sits inside <main> (the 404 page swaps <main> out), so aiming at
    // <main> itself would send the next Tab back to the link (QA OME-1308).
    const heading = page.locator("main h1#content");
    await expect(heading).toBeFocused();
    await expect(heading).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("Tab");
    await expect(skip).not.toBeFocused();
    expect(await page.evaluate(() => document.querySelector("main")?.contains(document.activeElement) ?? false)).toBe(true);
  });

  test(`${name}: nothing is wider than a 320px screen`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${URLS.web}/${name}.html`);
    const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scroll).toBeLessThanOrEqual(inner);
  });
}
