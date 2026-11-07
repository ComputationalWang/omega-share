import AxeBuilder from "@axe-core/playwright";
import type { Locator } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
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

/** The sheet reaches the screen's foot and no further: the footer's links are inside the Room sheet now (OME-1846). */
async function clearOfFooter(sheet: Locator): Promise<void> {
  const box = await sheet.boundingBox();
  const height = await sheet.page().evaluate(() => window.innerHeight);
  if (box === null) throw new Error("sheet not laid out");
  expect(box.y + box.height, "sheet bottom vs screen bottom").toBeLessThanOrEqual(height + 0.5);
  await expect(sheet.page().locator("body > .site-footer")).toBeHidden();
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
    const link = page.locator('[data-testid="portrait-link"]');
    await input.fill("last line with People open");
    await input.press("Enter");
    const last = page.locator(site.chatLogLine).last();
    await expect(last).toContainText("last line with People open");
    await page.locator(site.peopleKey).click();
    await expect(panel).toBeVisible();
    const dockVisible = async (visibleHeight: number): Promise<void> => {
      for (const target of [input, link, last]) await visibleInViewport(target, visibleHeight);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    };
    await dockVisible(height);
    // Android adjustResize shrinks layout and visual viewports together; keyboard inference
    // from their difference cannot guarantee that a sheet's controls fit its clipping bounds.
    await page.setViewportSize({ width, height: 440 });
    await link.click();
    const sheet = page.locator('[data-testid="portrait-sheet"]');
    await expect(sheet).toBeVisible();
    await expect(page.locator(site.queueUrl)).toBeFocused();
    for (const target of [page.locator(site.queueUrl), page.locator(site.queueAdd),
      page.locator('[data-testid="portrait-sheet-close"]')]) {
      await visibleInViewport(target, 440);
      const bounds = await sheet.boundingBox();
      const control = await target.boundingBox();
      expect(bounds).not.toBeNull();
      expect(control).not.toBeNull();
      expect(control?.width).toBeGreaterThanOrEqual(44);
      expect(control?.height).toBeGreaterThanOrEqual(44);
      expect(control?.y).toBeGreaterThanOrEqual(bounds?.y ?? 440);
      expect((control?.y ?? 440) + (control?.height ?? 440))
        .toBeLessThanOrEqual((bounds?.y ?? 0) + (bounds?.height ?? 0));
      expect(await target.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return [[rect.left + 2, rect.top + 2], [rect.right - 2, rect.bottom - 2]].every(([x, y]) => {
          if (x === undefined || y === undefined) return false;
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === el || el.contains(hit));
        });
      })).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(link).toBeFocused();
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
    await dockVisible(height - 300 + 24);
    const finalToggle = panel.locator(site.peopleToggle).last();
    await finalToggle.scrollIntoViewIfNeeded();
    await visibleInViewport(finalToggle, height - 300 + 24);
    await finalToggle.click();
    await expect(finalToggle).toHaveText("Show");
    await dockVisible(height - 300 + 24);
    await expect(page.locator(site.chatLog)).toHaveAttribute("role", "log");
    await expect(page.locator(site.chatLog)).toHaveAttribute("aria-live", "polite");
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("iframe").analyze();
    expect(axe.violations).toEqual([]);
    await finalToggle.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.locator(site.peopleKey)).toBeFocused();
    await visibleInViewport(page.locator(site.peopleKey), height - 300 + 24);
    await dockVisible(height - 300 + 24);
  });
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
    await clearOfFooter(sheet);
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
    await clearOfFooter(sheet);
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
    // OME-1297: rotating to landscape and back keeps playback, the seat and a draft, and the dock comes back.
    const seat = page.locator(`${site.seat}[data-occupied="false"]`).first();
    await seat.focus();
    await seat.press("Enter");
    await expect(page.locator(`${site.seat}.mine`)).toHaveCount(1);
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
    await expect(link).toHaveCount(0);
    await visibleInViewport(input, 390);
    await rotate(width, height);
    await expect(page.locator("#room-root")).toHaveClass(/room-portrait/);
    await expect(link).toBeVisible();
    for (const target of [input, link]) await visibleInViewport(target, height);
  });
}

// OME-2361: an own row in the Up next sheet (Move up/down and Remove keys) keeps its title, name, badge and keys apart,
// and the Remove key's box stays its 12-art-px sprite cell (a bigger box showed the atlas around it); the 44 px is its ::before.
for (const [width, height] of [[360, 740], [412, 915]] as const) {
  test(`${String(width)} portrait: an own Up next row keeps its title, badge and keys apart`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("m10-portrait", width === 360 ? "qrow360" : "qrow412").url,
      count: 1, nicknamePrefix: `qrow${String(width)}`,
      contextOptions: () => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("No portrait client");
    await page.locator('[data-testid="portrait-link"]').click();
    await expect(page.locator('[data-testid="portrait-sheet"]')).toBeVisible();
    const [firstVideo, nextVideo] = test.info().retry === 0 ? ["dQw4w9WgXcQ", "9bZkp7q19f0"] as const : ["M7lc1UVf-VE", "aqz-KE-bpKQ"] as const;
    await page.locator(site.queueUrl).fill(`https://youtu.be/${firstVideo}`);
    await page.locator(site.queueAdd).click();
    await expect(page.locator(site.sharedVideo)).toBeVisible();
    await page.locator(site.queueUrl).fill(`https://youtu.be/${nextVideo}`);
    await page.locator(site.queueAdd).click();
    const row = page.locator(site.queueRow).filter({ hasText: nextVideo });
    await expect(row.locator('[data-testid="queue-remove"]')).toBeVisible();
    const layout = await row.evaluate((li) => {
      const box = (sel: string): DOMRect => {
        const n = li.querySelector(sel);
        if (n === null) throw new Error(`no ${sel}`);
        return n.getBoundingClientRect();
      };
      const parts = { title: box(".title"), meta: box(".meta"), chip: box(".ui-chip"), up: box("[data-testid=queue-move-up]"),
        down: box("[data-testid=queue-move-down]"), remove: box("[data-testid=queue-remove]") };
      const overlaps: string[] = [];
      const names = Object.keys(parts) as (keyof typeof parts)[];
      for (const [i, a] of names.entries()) for (const b of names.slice(i + 1)) {
        const p = parts[a], q = parts[b];
        if (p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5) overlaps.push(`${a}×${b}`);
      }
      const rowBox = li.getBoundingClientRect();
      const outside = names.filter((n) => parts[n].left < rowBox.left - 0.5 || parts[n].right > rowBox.right + 0.5);
      const touch = (sel: string): number => {
        const n = li.querySelector(sel);
        if (n === null) throw new Error(`no ${sel}`);
        const r = n.getBoundingClientRect(), before = getComputedStyle(n, "::before");
        const bw = parseFloat(before.width), bh = parseFloat(before.height);
        return Math.min(Math.max(r.width, Number.isNaN(bw) ? 0 : bw), Math.max(r.height, Number.isNaN(bh) ? 0 : bh));
      };
      const x = li.querySelector("[data-testid=queue-remove]");
      const cell = x === null ? 0 : 12 * parseFloat(getComputedStyle(x).getPropertyValue("--ui-px"));
      return { overlaps, outside, cell, remove: [parts.remove.width, parts.remove.height],
        touch: [touch("[data-testid=queue-move-up]"), touch("[data-testid=queue-move-down]"), touch("[data-testid=queue-remove]")] };
    });
    expect(layout.overlaps, "title, name, badge and keys intersect").toEqual([]);
    expect(layout.outside, "parts past the row's edge").toEqual([]);
    expect(layout.remove, "Remove key box vs its sprite cell").toEqual([layout.cell, layout.cell]);
    for (const t of layout.touch) expect(t, "touch target").toBeGreaterThanOrEqual(44);
  });
}
