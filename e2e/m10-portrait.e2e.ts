import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { paintedContrast } from "./support/painted-contrast";
import { joinForToken, type ShareMember } from "./support/share";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
let clients: Client[] = [];
let members: ShareMember[] = [];
test.afterEach(async () => {
  for (const member of members) member.close();
  members = [];
  await leaveAll(clients);
  clients = [];
});

/** Axe over the page's own document; border-image contrast (keys, chat lines, the invite ticket) is judged by paintedContrast. */
async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("iframe").analyze();
  const out: string[] = [];
  for (const v of result.violations) {
    if (v.id !== "color-contrast") out.push(`${v.id}: ${v.help} | ${v.nodes.map((n) => n.target.join(" ")).join(" ; ")}`);
    else for (const n of v.nodes) {
      const [selector] = n.target;
      if (typeof selector === "string") out.push(...(await paintedContrast(page, selector)));
      else out.push(`color-contrast: ${n.target.join(" ")}`);
    }
  }
  return out;
}

async function visibleInViewport(target: Locator, height: number): Promise<void> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? height) + (box?.height ?? height)).toBeLessThanOrEqual(height);
}

for (const [width, height] of [[360, 740], [390, 844]] as const) {
  test(`${String(width)} portrait: People in a 25-member room keeps the dock visible, including with the keyboard open`, async ({ browser }) => {
    const room = testRoom("m10-portrait", width === 360 ? "people360" : "people390");
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: `people${String(width)}`,
      contextOptions: () => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("No portrait client");
    for (let i = 1; i <= 24; i++) members.push(await joinForToken(room.id, `person${String(i)}`));
    const panel = page.locator(site.peoplePanel);
    await expect(panel.locator(site.peopleRow)).toHaveCount(25);
    const input = page.locator(site.chatInput);
    const link = page.getByRole("tab", { name: "Up next", exact: true });
    await input.fill("last line with People open");
    await input.press("Enter");
    const last = page.locator(site.chatLogLine).last();
    await expect(last).toContainText("last line with People open");
    await page.locator(site.peopleKey).click();
    await expect(panel).toBeVisible();
    // The tabs give way to the composer while the keyboard is up (room.css .portrait-typing).
    const dockVisible = async (visibleHeight: number, typing = false): Promise<void> => {
      // The panel is longer than the typing viewport: the page scrolls, the composer sticks (OME-2306).
      if (typing) await last.evaluate((e) => { e.scrollIntoView({ block: "center" }); });
      for (const target of typing ? [input, last] : [input, link, last]) await visibleInViewport(target, visibleHeight);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    };
    await dockVisible(height);
    // Android adjustResize shrinks layout and visual viewports together. The panel is in the page's flow now (no sheet):
    // Up next's field and Add key are reachable (scrolled to) and finger-sized.
    await page.setViewportSize({ width, height: 440 });
    await link.click();
    await expect(page.locator(site.queuePanel)).toBeVisible();
    for (const target of [page.locator(site.queueUrl), page.locator(site.queueAdd)]) {
      // Centred, as a thumb scroll would: the sticky tabs and composer cover the page's edges.
      await target.evaluate((e) => { e.scrollIntoView({ block: "center" }); });
      await visibleInViewport(target, 440);
      const control = await target.boundingBox();
      expect(control?.width).toBeGreaterThanOrEqual(44);
      expect(control?.height).toBeGreaterThanOrEqual(44);
      expect(await target.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return [[rect.left + 2, rect.top + 2], [rect.right - 2, rect.bottom - 2]].every(([x, y]) => {
          if (x === undefined || y === undefined) return false;
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === el || el.contains(hit));
        });
      })).toBe(true);
    }
    await page.locator('[data-testid="portrait-chat"]').click();
    await page.setViewportSize({ width, height });
    await dockVisible(height);
    await input.focus();
    await page.evaluate((visibleHeight) => {
      const viewport = new EventTarget();
      Object.assign(viewport, { height: visibleHeight, width: innerWidth, offsetTop: 24, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
      window.dispatchEvent(new Event("resize"));
    }, height - 300);
    await expect(page.locator("#room-root")).toHaveClass(/portrait-typing/);
    await expect(panel).toBeVisible();
    await expect(input).toBeFocused();
    await dockVisible(height - 300 + 24, true);
    const finalToggle = panel.locator(site.peopleToggle).last();
    await finalToggle.scrollIntoViewIfNeeded();
    await visibleInViewport(finalToggle, height - 300 + 24);
    await finalToggle.click();
    await expect(finalToggle).toHaveText("Show");
    await dockVisible(height - 300 + 24, true);
    await expect(page.locator(site.chatLog)).toHaveAttribute("role", "log");
    await expect(page.locator(site.chatLog)).toHaveAttribute("aria-live", "polite");
    expect(await violations(page)).toEqual([]);
    await finalToggle.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.locator(site.peopleKey)).toBeFocused();
    await visibleInViewport(page.locator(site.peopleKey), height - 300 + 24);
    await dockVisible(height - 300 + 24, true);
  });
}

for (const [width, height] of [[360, 740], [390, 844]] as const) {
  test(`${String(width)} portrait: composer, share sheet, live chat and keyboard stay in the viewport`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("m10-portrait", width === 360 ? "360" : "390").url,
      count: 1, nicknamePrefix: `portrait${String(width)}`,
      contextOptions: () => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("No portrait client");
    // Up next is a tab of the one panel now (OME-2306): no sheet, no focus trap, no Link key.
    const link = page.getByRole("tab", { name: "Up next", exact: true });
    const input = page.locator(site.chatInput);
    await expect(page.locator("#room-root")).toHaveClass(/room-portrait/);
    // Sit first (OME-1297): once a video is up the phone's room strip is its 96 px floor and crops every seat (inert).
    const seat = page.locator(`${site.seat}[data-occupied="false"]`).first();
    await seat.focus();
    await seat.press("Enter");
    await expect(page.locator(`${site.seat}.mine`)).toHaveCount(1);
    await input.fill("last line stays visible");
    await input.press("Enter");
    const last = page.locator(site.chatLogLine).last();
    await expect(last).toContainText("last line stays visible");
    for (const target of [input, link, last]) await visibleInViewport(target, height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const axe = async (): Promise<void> => {
      expect(await violations(page)).toEqual([]);
    };
    expect((await input.boundingBox())?.width).toBeGreaterThanOrEqual(140);
    await axe();
    await link.click();
    await expect(link).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(site.queuePanel)).toBeVisible();
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
    await page.locator('[data-testid="portrait-chat"]').click();
    await expect(page.locator(site.chatLog)).toHaveAttribute("role", "log");
    await expect(page.locator(site.chatLog)).toHaveAttribute("aria-live", "polite");
    await axe();
    // Back on Up next, so the field is the keyboard's target below.
    await link.click();
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
    // The tabs give way to the composer while the keyboard is up; the Up next field is still one thumb scroll away.
    const url = page.locator(site.queueUrl);
    await url.focus();
    await url.evaluate((e) => { e.scrollIntoView({ block: "center" }); });
    await visibleInViewport(url, height - 300 + 24);
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (viewport === null) throw new Error("No visual viewport");
      Object.assign(viewport, { height: 320, offsetTop: 24 });
      window.dispatchEvent(new Event("resize"));
    });
    await url.evaluate((e) => { e.scrollIntoView({ block: "center" }); });
    await visibleInViewport(url, 344);
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (viewport === null) throw new Error("No visual viewport");
      Object.assign(viewport, { height: innerHeight, offsetTop: 0 });
      window.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator("#room-root")).not.toHaveClass(/portrait-typing/);
    // OME-1297: rotating to landscape and back keeps playback, the seat and a draft, and the dock comes back.
    const video = page.locator(site.sharedVideo);
    // Marked, so a rebuilt player (playback restarting) would show.
    await video.evaluate((node) => { node.dataset["e2eKept"] = "1"; });
    await input.fill("draft across a turn");
    const rotate = async (w: number, h: number): Promise<void> => {
      await page.setViewportSize({ width: w, height: h });
      // The simulated visualViewport above stays installed: keep it in step with the layout viewport.
      await page.evaluate(() => {
        const viewport = window.visualViewport;
        if (viewport === null) throw new Error("No visual viewport");
        Object.assign(viewport, { width: innerWidth, height: innerHeight, offsetTop: 0 });
        window.dispatchEvent(new Event("resize"));
      });
      await expect(video).toHaveAttribute("data-e2e-kept", "1");
      await expect(page.locator(`${site.seat}.mine`)).toHaveCount(1);
      await expect(input).toHaveValue("draft across a turn");
    };
    await rotate(844, 390);
    await expect(page.locator("#room-root")).not.toHaveClass(/room-portrait/);
    await expect(page.locator("#room-root")).toHaveClass(/room-wide/);
    await visibleInViewport(input, 390);
    await rotate(width, height);
    await expect(page.locator("#room-root")).toHaveClass(/room-portrait/);
    await expect(link).toBeVisible();
    for (const target of [input, link]) await visibleInViewport(target, height);
  });
}
