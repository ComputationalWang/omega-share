// The popup on a phone (OME-743): Firefox for Android opens it as a full-screen sheet 360-412 px wide with a touch pointer.
// Chromium here stands in: the popup page opened as a tab, a viewport of that width, and CDP touch emulation, which makes
// `(pointer: coarse)` match. Desktop keeps its fixed 320 px body (Chrome sizes the popup to its content) with a fine pointer.
import type { BrowserContext, Page } from "@playwright/test";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test } from "./support/extension";
import { ownedRoom } from "./support/owned-rooms";
import { site } from "./support/selectors";

test.fixme(!available.extension, PENDING.extension);
test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const LONG_HOST = `${"a".repeat(50)}.${"b".repeat(50)}.omega-fixture.org`;
const SHOTS = process.env["OME_743_SHOTS"];

async function setup(context: BrowserContext, openPopup: (p: Page) => Promise<Page>): Promise<Page> {
  await context.route(`${URLS.fixtures}/long-host.html`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>long</title><iframe src="https://www.youtube.com/embed/aqz-KE-bpKQ"></iframe><iframe src="https://${LONG_HOST}/embed/1"></iframe><iframe src="https://player.twitch.tv/?channel=averyverylongchannelname1&parent=localhost"></iframe>`,
    }),
  );
  const room = ownedRoom("extqempa");
  const member = await context.newPage();
  await member.goto(`${URLS.web}/r/${room.id}#k=${room.inviteKey}`);
  await member.locator(site.nicknameInput).fill("ext-phone");
  await member.locator(site.joinButton).click();
  await expect(member.locator(site.room)).toBeVisible();
  const source = await context.newPage();
  await source.goto(`${URLS.fixtures}/long-host.html`);
  return openPopup(source);
}

test.describe("touch phone", () => {
  // Chromium's own switch for a touch device: `(pointer: coarse)` and `(hover: none)` match, as on Android.
  test.use({ extraArgs: ["--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1"] });
for (const [width, height] of [[360, 740], [412, 915]] as const) {
  test(`the popup fits and is usable at ${String(width)} px on a touch phone`, async ({ context, openPopup }) => {
    const popup = await setup(context, openPopup);
    await popup.setViewportSize({ width, height });
    await popup.reload();
    await expect(popup.locator("[data-testid=embed-item]")).toHaveCount(3);
    await expect(popup.locator("[data-testid=share-button]")).toBeVisible();
    if (SHOTS !== undefined) await popup.screenshot({ path: `${SHOTS}/popup-${String(width)}.png` });

    expect(await popup.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    // Readable: a viewport meta, so Android lays out at device width instead of 980 px.
    expect.soft(await popup.evaluate(() => document.querySelector("meta[name=viewport]")?.getAttribute("content"))).toBe("width=device-width, initial-scale=1");
    // Fills the sheet, no sideways scroll.
    const m = await popup.evaluate(() => ({ body: document.body.getBoundingClientRect().width, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect.soft(m.body).toBe(width);
    expect.soft(m.sw).toBeLessThanOrEqual(m.cw);

    // Touch targets: at least 44 x 44.
    const targets = ["[data-testid=embed-item] label", "[data-testid=room-select]", "[data-testid=share-button]", "[data-testid=queue-button]", "[data-testid=open-options]"];
    for (const sel of targets) {
      const boxes = await popup.locator(sel).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
      expect.soft(boxes.length, sel).toBeGreaterThan(0);
      for (const b of boxes) {
        expect.soft(b.h, `${sel} height`).toBeGreaterThanOrEqual(44);
        expect.soft(b.w, `${sel} width`).toBeGreaterThanOrEqual(44);
      }
    }

    // Focus is visible on every control, tabbing through.
    const seen = new Set<string>();
    for (let i = 0; i < 9; i++) {
      await popup.keyboard.press("Tab");
      const f = await popup.evaluate(() => {
        const e = document.activeElement;
        if (e === null || e === document.body) return null;
        const s = getComputedStyle(e);
        return { id: e.id !== "" ? e.id : (e.getAttribute("name") ?? e.tagName), visible: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && e.matches(":focus-visible") };
      });
      if (f === null) continue;
      seen.add(f.id);
      expect.soft(f.visible, `focus ring on ${f.id}`).toBe(true);
    }
    for (const id of ["room", "share", "queue", "options"]) expect(seen.has(id), id).toBe(true);
  });
}

});

test("on a desktop (fine pointer) the popup body stays 320 px wide", async ({ context, openPopup }) => {
  const popup = await setup(context, openPopup);
  await popup.setViewportSize({ width: 800, height: 600 });
  await expect(popup.locator("[data-testid=embed-item]")).toHaveCount(3);
  expect(await popup.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
  expect(await popup.evaluate(() => document.body.getBoundingClientRect().width)).toBe(320);
  const share = await popup.locator("[data-testid=share-button]").boundingBox();
  expect(share?.height).toBeLessThan(44);
});
