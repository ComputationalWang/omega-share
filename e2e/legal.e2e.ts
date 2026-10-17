// OME-1299: the legal pages get the landing's skip link (first Tab stop, focus moves to <main>), and none of them
// scrolls sideways on a 320px phone (QA OME-1300 F6, WCAG 1.4.10).
import { expect, test } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";

test.fixme(!available.web, PENDING.web);

const PAGES = ["terms", "privacy", "licenses", "contact"] as const;

for (const name of PAGES) {
  test(`${name}: the skip link is the first Tab stop and moves focus to <main>`, async ({ page }) => {
    await page.goto(`${URLS.web}/${name}.html`);
    const skip = page.locator(".skip-link");
    await expect(skip).not.toBeInViewport();
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await expect(skip).toHaveText("Skip to content");
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await expect(page.locator("main")).toHaveAttribute("tabindex", "-1");
  });

  test(`${name}: nothing is wider than a 320px screen`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${URLS.web}/${name}.html`);
    const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scroll).toBeLessThanOrEqual(inner);
  });
}
