// The popup's a11y (OME-1286, WCAG 4.1.3, 2.4.3, 2.5.8): the two status lines are live regions from the start, so a
// message put in them is announced; focus never falls to <body>; the footer's text keys are at least 24 × 24 px.
// OME-1808: the share key's label and icon fit inside it with every room choice, and no popup text is under 12 px.
import type { BrowserContext, Page } from "@playwright/test";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test } from "./support/extension";
import { gotoFixture } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { popup, site } from "./support/selectors";

test.fixme(!available.extension, PENDING.extension);
test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const REGIONS = [popup.shareStatus, '[data-testid="server-status"]'] as const;

/** A member tab in an owned room (a share token, so no server line), and the popup opened on a YouTube embed page. */
async function setup(context: BrowserContext, openPopup: (target: Page) => Promise<Page>): Promise<{ p: Page; roomId: string }> {
  const room = ownedRoom("extfocus");
  const tab = await context.newPage();
  await tab.goto(`${URLS.web}/r/${room.id}#k=${room.inviteKey}`);
  await tab.locator(site.nicknameInput).fill("ext-a11y");
  await tab.locator(site.joinButton).click();
  await expect(tab.locator(site.room)).toBeVisible();
  const source = await context.newPage();
  await gotoFixture(source, "youtube-embed");
  return { p: await openPopup(source), roomId: room.id };
}

test("both status lines are live regions in the a11y tree, empty while idle", async ({ context, openPopup }) => {
  const { p, roomId } = await setup(context, openPopup);
  await expect(p.locator(popup.embedItem)).toHaveCount(1);
  await p.locator(popup.roomSelect).selectOption(roomId);
  await expect(p.locator(popup.shareButton)).toBeEnabled();
  for (const region of REGIONS) {
    const el = p.locator(region);
    await expect(el).toHaveAttribute("role", "status");
    await expect(el).not.toHaveAttribute("hidden");
    await expect(el).toHaveText("");
    // In the a11y tree: not display:none or visibility:hidden, only out of the way while empty.
    const style = await el.evaluate((e) => ({ display: getComputedStyle(e).display, visibility: getComputedStyle(e).visibility }));
    expect(style.display).not.toBe("none");
    expect(style.visibility).toBe("visible");
  }
  await expect(p.getByRole("status").and(p.locator(popup.shareStatus))).toHaveCount(1);
  await expect(p.getByRole("status").and(p.locator(REGIONS[1]))).toHaveCount(1);
});

test("the checked embed has focus once the list renders, and Enter on Share keeps focus off <body>", async ({ context, openPopup }) => {
  const { p, roomId } = await setup(context, openPopup);
  await expect(p.locator(popup.embedItem)).toHaveCount(1);
  await expect(p.locator(`${popup.embedItem} input[name=embed]:checked`)).toBeFocused();
  await p.locator(popup.roomSelect).selectOption(roomId);
  await expect(p.locator(popup.shareButton)).toBeEnabled();
  await p.locator(popup.shareButton).focus();
  await p.keyboard.press("Enter");
  expect(await p.evaluate(() => document.activeElement === document.body)).toBe(false);
  await expect(p.locator(popup.shareStatus)).toHaveText("Shared · Open room");
  await expect(p.locator(popup.shareButton)).toBeFocused();
});

test("Server settings and the legal links are at least 24 × 24 px with a mouse", async ({ context, openPopup }) => {
  const { p } = await setup(context, openPopup);
  await p.setViewportSize({ width: 800, height: 600 });
  await expect(p.locator(popup.embedItem)).toHaveCount(1);
  expect(await p.evaluate(() => matchMedia("(hover: none)").matches)).toBe(false);
  const targets = p.locator('[data-testid="open-options"], [data-testid="legal-links"] a');
  await expect(targets).toHaveCount(4);
  for (const box of await Promise.all((await targets.all()).map((t) => t.boundingBox()))) {
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
  }
});

for (const width of [360, 420]) {
  test(`at ${String(width)} px the share key fits its label and icon with every room choice, and no text is under 12 px (OME-1808)`, async ({ context, openPopup }) => {
    const { p, roomId } = await setup(context, openPopup);
    await p.setViewportSize({ width, height: 700 });
    await expect(p.locator(popup.embedItem)).toHaveCount(1);
    const key = p.locator(popup.shareButton);
    for (const [room, label] of [[{ label: "New room…" }, "Create room & share"], [roomId, "Share"]] as const) {
      await p.locator(popup.roomSelect).selectOption(room);
      await expect(key).toHaveText(label);
      // The label isn't clipped and every child (icon, label) sits inside the key's box.
      const fit = await key.evaluate((b) => {
        const k = b.getBoundingClientRect();
        const inside = [...b.children].every((c) => {
          const r = c.getBoundingClientRect();
          return r.left >= k.left && r.right <= k.right && r.top >= k.top && r.bottom <= k.bottom;
        });
        return { inside, overflow: b.scrollWidth > b.clientWidth };
      });
      expect(fit, `${label} at ${String(width)} px`).toEqual({ inside: true, overflow: false });
    }
    const small = await p.evaluate(() => {
      const out: string[] = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
        const el = n.parentElement;
        if (el === null || n.textContent?.trim() === "" || el.closest("script, [hidden]") !== null) continue;
        const size = Number.parseFloat(getComputedStyle(el).fontSize);
        if (size < 12) out.push(`${String(size)}px: ${n.textContent?.trim() ?? ""}`);
      }
      return out;
    });
    expect(small).toEqual([]);
  });
}
