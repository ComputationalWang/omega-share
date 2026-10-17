// A phone held sideways (OME-1297): 601–1023 px wide and short. The room page uses the wide two-column layout with a
// narrower chat column, so the picture fits the height and the shelf, Up next and the chat field are in view without
// scrolling the page; the chat column follows the visual viewport while the keyboard is up, and the notch stays clear.
// The rotation round trip (portrait dock back, playback, seat and draft kept) is in m10-portrait.e2e.ts.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
}

/** Wholly inside [left, right] × [top, bottom] of the layout viewport. */
async function inside(l: Locator, top: number, bottom: number, left = 0, right = Infinity): Promise<void> {
  await expect(l).toBeVisible();
  const b = await box(l);
  expect(b.y).toBeGreaterThanOrEqual(top);
  expect(b.y + b.height).toBeLessThanOrEqual(bottom);
  expect(b.x).toBeGreaterThanOrEqual(left);
  expect(b.x + b.width).toBeLessThanOrEqual(right);
  // A box can sit in the viewport yet be clipped by a scrolling ancestor (QA OME-1305): the finger must land on it.
  expect(await l.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === node || node.contains(hit)) ? "reachable" : hit?.outerHTML.slice(0, 80) ?? "nothing";
  }), String(l)).toBe("reachable");
}

async function open(browser: Parameters<typeof joinRoom>[0], name: "l932" | "l844" | "l667" | "notch", width: number, height: number): Promise<Page> {
  clients = await joinRoom(browser, { roomUrl: testRoom("landscape-phone", name).url, count: 1, nicknamePrefix: `land${name}`,
    contextOptions: () => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(page.locator(site.chatInput)).toBeVisible();
  return page;
}

for (const [name, width, height] of [["l932", 932, 430], ["l844", 844, 390], ["l667", 667, 375]] as const) {
  test(`${String(width)}×${String(height)} landscape: picture, shelf, Up next and chat fit unscrolled; the field stays above the keyboard`, async ({ browser }) => {
    const page = await open(browser, name, width, height);
    await expect(page.locator("#room-root")).not.toHaveClass(/room-portrait/);
    const input = page.locator(site.chatInput);
    for (const l of [site.tv, site.playToggle, site.queueUrl, site.chatInput]) await inside(page.locator(l), 0, height, 0, width);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0)).toBeLessThanOrEqual(width);
    // The picture keeps its ADR 0012 minimum; the field keeps its room.
    expect((await box(page.locator(site.tv))).width).toBeGreaterThanOrEqual(356);
    expect((await box(input)).width).toBeGreaterThanOrEqual(120);
    expect((await box(page.locator(site.queueUrl))).width).toBeGreaterThanOrEqual(120);

    await input.fill("sideways hello");
    await input.press("Enter");
    await expect(page.locator(site.chatLogLine).last()).toContainText("sideways hello");

    // The OS keyboard is outside browser automation: simulate its visualViewport (iOS keeps the layout viewport).
    await input.focus();
    const kb = { top: 24, height: height - 220 };
    await page.evaluate(({ top, height: h }) => {
      const v = new EventTarget();
      Object.assign(v, { height: h, width: innerWidth, offsetTop: top, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: v });
      window.dispatchEvent(new Event("resize"));
    }, kb);
    await expect(input).toBeFocused();
    await expect.poll(async () => { const b = await box(input); return b.y + b.height; }).toBeLessThanOrEqual(kb.top + kb.height);
    await inside(input, kb.top, kb.top + kb.height);
    // The keyboard goes: the column is full height again.
    await page.evaluate(() => {
      const v = window.visualViewport;
      if (v === null) throw new Error("no visual viewport");
      Object.assign(v, { height: innerHeight, offsetTop: 0 });
      window.dispatchEvent(new Event("resize"));
    });
    await expect.poll(async () => { const b = await box(input); return b.y + b.height; }).toBeGreaterThan(kb.top + kb.height);
    await inside(input, 0, height);
  });
}

test("844×390 landscape with a notch: the room and the chat column keep clear of the side insets", async ({ browser }) => {
  const page = await open(browser, "notch", 844, 390);
  const cdp = await page.context().newCDPSession(page);
  const inset = 47;
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: inset, right: inset } });
  for (const l of [site.tv, site.playToggle, site.queueUrl, site.chatInput, site.chatLog]) {
    await expect.poll(async () => (await box(page.locator(l))).x).toBeGreaterThanOrEqual(inset);
    await inside(page.locator(l), 0, 390, inset, 844 - inset);
  }
});
