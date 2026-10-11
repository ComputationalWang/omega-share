import AxeBuilder from "@axe-core/playwright";
import type { Locator } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
let clients: Client[] = [];
test.afterEach(async () => { await leaveAll(clients); clients = []; });

async function visibleInViewport(target: Locator, height: number): Promise<void> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? height) + (box?.height ?? height)).toBeLessThanOrEqual(height);
}

for (const [width, height] of [[360, 740], [390, 844]] as const) {
  test(`${String(width)} portrait: composer, share sheet, live chat and keyboard stay in the viewport`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("m10-portrait", width === 360 ? "360" : "390").url,
      count: 1, nicknamePrefix: `portrait${String(width)}`,
      contextOptions: () => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("No portrait client");
    const link = page.locator('[data-testid="portrait-link"]');
    const input = page.locator(site.chatInput);
    await expect(page.locator("#room-root")).toHaveClass(/room-portrait/);
    await input.fill("last line stays visible");
    await input.press("Enter");
    const last = page.locator(site.chatLogLine).last();
    await expect(last).toContainText("last line stays visible");
    for (const target of [input, link, last]) await visibleInViewport(target, height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const axe = async (): Promise<void> => {
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("iframe").analyze();
      expect(result.violations).toEqual([]);
    };
    expect((await input.boundingBox())?.width).toBeGreaterThanOrEqual(140);
    await axe();
    await link.click();
    const sheet = page.locator('[data-testid="portrait-sheet"]');
    await expect(sheet).toBeVisible();
    await expect(page.locator(site.queueUrl)).toBeFocused();
    // Each retry uses fresh video IDs so existing queue state cannot satisfy this share assertion.
    const [firstVideo, nextVideo] = test.info().retry === 0
      ? ["dQw4w9WgXcQ", "9bZkp7q19f0"] as const
      : ["M7lc1UVf-VE", "aqz-KE-bpKQ"] as const;
    const queued = page.locator(site.queueRow).filter({ hasText: nextVideo });
    await expect(queued).toHaveCount(0);
    await page.locator(site.queueUrl).fill(`https://youtu.be/${firstVideo}`);
    await page.locator(site.queueAdd).click();
    await expect(page.locator(site.sharedVideo)).toBeVisible();
    await page.locator(site.queueUrl).fill(`https://youtu.be/${nextVideo}`);
    await page.locator(site.queueAdd).click();
    await expect(queued).toHaveCount(1);
    await expect(queued).toContainText(nextVideo);
    await axe();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(link).toBeFocused();
    await page.locator('[data-testid="portrait-chat"]').click();
    await expect(page.locator(site.chatLog)).toHaveAttribute("role", "log");
    await expect(page.locator(site.chatLog)).toHaveAttribute("aria-live", "polite");
    await expect(page.locator(site.chatLog)).toBeFocused();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await axe();
    await page.keyboard.press("Escape");
    await input.focus();
    // The OS keyboard is outside browser automation. Simulate its public visualViewport events,
    // preserving the layout viewport exactly as a real keyboard does.
    await page.evaluate((visibleHeight) => {
      const v = new EventTarget();
      Object.assign(v, { height: visibleHeight, width: innerWidth, offsetTop: 24, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: v });
      // The production listener was installed on the native viewport; a window resize also refreshes it.
      window.dispatchEvent(new Event("resize"));
    }, height - 300);
    await expect(page.locator("#room-root")).toHaveClass(/portrait-typing/);
    await visibleInViewport(input, height - 300 + 24);
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    await link.click();
    await expect(page.locator(site.queueUrl)).toBeFocused();
    await visibleInViewport(page.locator(site.queueUrl), height - 300 + 24);
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (viewport === null) throw new Error("No visual viewport");
      Object.assign(viewport, { height: 320, offsetTop: 24 });
      window.dispatchEvent(new Event("resize"));
    });
    await visibleInViewport(page.locator(site.queueUrl), 344);
    await visibleInViewport(page.locator('[data-testid="portrait-sheet-close"]'), 344);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (viewport === null) throw new Error("No visual viewport");
      Object.assign(viewport, { height: innerHeight, offsetTop: 0 });
      window.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator("#room-root")).not.toHaveClass(/portrait-typing/);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("#room-root")).not.toHaveClass(/room-portrait/);
    await expect(link).toHaveCount(0);
  });
}
