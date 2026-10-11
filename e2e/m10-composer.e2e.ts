// OME-905 (M10 W1, board item 1): the chat composer in full screen on a phone. In every full-screen layout, strip open
// or collapsed to the band, in portrait and landscape, the message field gets at least 60 % of its row and 140 px;
// on touch the send key is a 44 px icon named "Send", the keyboard shows a Send key, Enter sends, and focus stays in
// the field after sending (a tap on the key too, so the keyboard stays up). The geometry is apps/web/test/fullscreen.test.ts.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import type { RoomName } from "./support/test-rooms";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const box = async (l: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
};

const fieldFocused = (page: Page): Promise<boolean> => page.evaluate((sel) => document.activeElement?.matches(sel) === true, site.chatInput);

/** The composer row in the strip (or the band): the field gets ≥ 60 % of it and ≥ 140 px; the send key is ≥ 44×44. */
async function expectRoomy(page: Page, where: string): Promise<void> {
  const strip = page.locator(site.fsStrip);
  const row = await box(strip.locator("form.chat"));
  const field = await box(strip.locator(site.chatInput));
  const send = await box(strip.getByRole("button", { name: "Send", exact: true }));
  expect(field.width, `${where}: field ${String(field.width)} of row ${String(row.width)}`).toBeGreaterThanOrEqual(140);
  expect(field.width / row.width, `${where}: field share of the row`).toBeGreaterThanOrEqual(0.6);
  expect(send.width, `${where}: send key width`).toBeGreaterThanOrEqual(44);
  expect(send.height, `${where}: send key height`).toBeGreaterThanOrEqual(44);
  // Nothing in the row spills out of the strip or the screen.
  const s = await box(strip);
  const vp = page.viewportSize();
  expect(row.x).toBeGreaterThanOrEqual(s.x - 0.5);
  expect(row.x + row.width).toBeLessThanOrEqual(s.x + s.width + 0.5);
  expect(row.x + row.width).toBeLessThanOrEqual((vp?.width ?? 0) + 0.5);
  expect(field.y + field.height).toBeLessThanOrEqual((vp?.height ?? 0) + 0.5);
}

/** Enter sends, and so does a tap on the send key; the line shows in the log and focus never leaves the field. */
async function expectSends(page: Page, text: string): Promise<void> {
  const strip = page.locator(site.fsStrip);
  const input = strip.locator(site.chatInput);
  await expect(input).toHaveAttribute("enterkeyhint", "send");
  await input.tap();
  await input.fill(`${text} enter`);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.locator(site.chatLog)).toContainText(`${text} enter`);
  expect(await fieldFocused(page)).toBe(true);
  await input.fill(`${text} tap`);
  await strip.getByRole("button", { name: "Send", exact: true }).tap();
  await expect(input).toHaveValue("");
  await expect(page.locator(site.chatLog)).toContainText(`${text} tap`);
  expect(await fieldFocused(page)).toBe(true);
}

const SIZES: readonly (readonly [RoomName<"m10-composer">, number, number])[] = [
  ["l568", 568, 320],
  ["l667", 667, 375],
  ["l932", 932, 430],
  ["p360", 360, 740],
  ["p390", 390, 844],
];

for (const [name, width, height] of SIZES) {
  test(`${String(width)}×${String(height)} full screen: the field is roomy and sends, with the strip open and as the band`, async ({ browser }) => {
    clients = await joinRoom(browser, {
      roomUrl: testRoom("m10-composer", name).url,
      count: 1,
      nicknamePrefix: `c${name}`,
      contextOptions: () => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }),
    });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    await page.locator(site.fullscreenToggle).click();
    const strip = page.locator(site.fsStrip);
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute("data-strip", "open");
    // The emote key is still one tap away in full screen, wherever it sits.
    await expect(strip.locator(site.emoteKey)).toBeVisible();
    await expectRoomy(page, "open");
    await expectSends(page, `${name} open`);

    await page.locator(site.fsStripToggle).click();
    await expect(strip).toHaveAttribute("data-strip", "band");
    await expect(strip.locator(site.emoteKey)).toBeVisible();
    await expectRoomy(page, "band");
    await expectSends(page, `${name} band`);
  });
}
