// Harness self-checks: fixture pages are served and external network is stubbed.
import { expect, test } from "./support/csp";
import { EMBED_URL, WATCH_URL, gotoFixture, stubExternalNetwork } from "./support/network";

test.beforeEach(async ({ context }) => {
  await stubExternalNetwork(context);
});

test("YouTube embed fixture has one allowlisted iframe", async ({ page }) => {
  await gotoFixture(page, "youtube-embed");
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(page.locator("iframe#yt")).toHaveAttribute("src", EMBED_URL);
});

test("watch-URL fixture is served at a youtube.com/watch URL, offline", async ({ page }) => {
  await gotoFixture(page, "watch-url");
  expect(page.url()).toBe(WATCH_URL);
  await expect(page.locator("#movie_player")).toBeVisible();
});

test("non-allowlisted fixture has only non-YouTube iframes", async ({ page }) => {
  await gotoFixture(page, "non-allowlisted");
  const hosts = await page.locator("iframe").evaluateAll((els) =>
    els.map((el) => {
      const src = el.getAttribute("src") ?? "";
      return URL.canParse(src) ? new URL(src).hostname : src;
    }),
  );
  expect(hosts.length).toBeGreaterThan(0);
  for (const h of hosts) expect(["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"]).not.toContain(h);
});

test("no-video fixture has no iframes or video elements", async ({ page }) => {
  await gotoFixture(page, "no-video");
  await expect(page.locator("iframe, video")).toHaveCount(0);
});
