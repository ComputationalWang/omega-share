// M2 share → room (OME-131): on a page with all three providers, the popup shares each listed embed in turn and the
// room tab mounts that provider's player with its canonical ids. Runs in `e2e-sync` because each share replaces the lobby's video.
import { expect, test } from "./support/extension";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import type { Page } from "@playwright/test";
import { PENDING, URLS, available } from "./support/apps";
import { EMBED_URL, VIDEO_ID, gotoFixture } from "./support/network";
import { popup, site } from "./support/selectors";

const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;
const plate = '[data-testid="provider-plate"]';

interface Expected {
  readonly url: string;
  readonly plate: string;
  /** Checks the player the room mounted. */
  readonly player: (room: Page) => Promise<void>;
}

// OME-244: Twitch's mature gate can't be detected from outside its player, so every Twitch embed shows this hint.
const TWITCH_HINT = "If the Twitch player asks, press Start Watching in it.";

/** The SDK builds `https://player.twitch.tv?…` inside our `.tv-sdk` box; match the origin, then pin the ids. */
async function twitchSrc(room: Page): Promise<URL> {
  const frame = room.locator(`${site.sharedVideo} iframe[src^="https://player.twitch.tv"]`);
  await expect(frame).toHaveCount(1, { timeout: 15_000 });
  const src = new URL((await frame.getAttribute("src")) ?? "");
  expect(src.origin).toBe("https://player.twitch.tv");
  expect(src.searchParams.getAll("parent")).toEqual([new URL(URLS.web).hostname]);
  return src;
}

// The four embeds of fixtures/pages/providers-embed.html, as the popup lists them (canonical URLs, ADR 0014).
const EXPECTED: readonly Expected[] = [
  {
    url: EMBED_URL,
    plate: "YouTube",
    player: async (room) => {
      const src = new URL((await room.locator(site.sharedVideo).getAttribute("src")) ?? "");
      expect(`${src.origin}${src.pathname}`).toBe(`https://www.youtube-nocookie.com/embed/${VIDEO_ID}`);
      await expect(room.locator(site.tvHint)).toBeHidden();
    },
  },
  {
    url: "https://player.twitch.tv/?channel=somechannel",
    plate: "Twitch",
    player: async (room) => {
      const src = await twitchSrc(room);
      expect([src.searchParams.get("channel"), src.searchParams.get("video")]).toEqual(["somechannel", null]);
      await expect(room.locator('[data-testid="live-pill"]')).toBeVisible();
      await expect(room.locator(site.tvHint)).toHaveText(TWITCH_HINT);
    },
  },
  {
    url: "https://player.twitch.tv/?video=v1234567890",
    plate: "Twitch",
    player: async (room) => {
      const src = await twitchSrc(room);
      expect([src.searchParams.get("video"), src.searchParams.get("channel")]).toEqual(["v1234567890", null]);
      await expect(room.locator('[data-testid="live-pill"]')).toBeHidden();
      await expect(room.locator(site.tvHint)).toHaveText(TWITCH_HINT);
    },
  },
  {
    url: "https://player.vimeo.com/video/76979871?h=8272103f6e",
    plate: "Vimeo",
    player: async (room) => {
      const src = new URL((await room.locator(site.sharedVideo).getAttribute("src")) ?? "");
      expect(`${src.origin}${src.pathname}`).toBe("https://player.vimeo.com/video/76979871");
      expect(src.searchParams.get("h")).toBe("8272103f6e");
      // None of the page's own player params (badge, app_id, player_id…) survive the canonical form.
      expect(src.searchParams.has("app_id")).toBe(false);
      await expect(room.locator(site.tvHint)).toBeHidden();
    },
  },
];

test.describe("M2 share from the extension → room shows the right provider", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.fixme(!available.extension, PENDING.extension);

  test("each of the 4 embeds on the providers page lands in the room as its provider", async ({ context, openPopup }, info) => {
    test.setTimeout(120_000);
    // The popup reads the share token from an open room tab of the site (OME-130/OME-142): join and keep it open.
    const room = await context.newPage();
    await room.goto(ROOM_URL);
    await room.locator(site.nicknameInput).fill("provider-share");
    await room.locator(site.avatarOption).first().click();
    await room.locator(site.joinButton).click();
    await expect(room.locator(site.room)).toBeVisible();
    const source = await context.newPage();
    await gotoFixture(source, "providers-embed");

    const listed = await (async () => {
      const p = await openPopup(source);
      await expect(p.locator(popup.embedItem)).toHaveCount(4);
      const values = await p.locator(`${popup.embedItem} input[name=embed]`).evaluateAll((els) => els.map((e) => (e instanceof HTMLInputElement ? e.value : "")));
      await p.close();
      return values;
    })();
    expect([...listed].sort()).toEqual(EXPECTED.map((e) => e.url).sort());

    for (const e of EXPECTED) {
      await test.step(`${e.plate}: ${e.url}`, async () => {
        // The server's per-IP share limiter (5 burst, 1 per 3 s) is shared with every spec, so retry a refused share.
        await expect
          .poll(async () => {
            const p = await openPopup(source);
            await p.locator(`${popup.embedItem} input[name=embed][value="${e.url}"]`).check();
            await expect(p.locator(popup.shareButton)).toBeEnabled();
            await p.locator(popup.shareButton).click();
            await expect(p.locator(popup.shareStatus)).toBeVisible();
            const state = await p.locator(popup.shareStatus).getAttribute("data-state");
            await p.close();
            return state;
          }, { timeout: 30_000, intervals: [3_000] })
          .toBe("ok");
        await expect(room.locator(plate)).toContainText(e.plate, { timeout: 15_000 });
        await e.player(room);
        await info.attach(`room-${e.plate}-${String(EXPECTED.indexOf(e))}`, { body: await room.screenshot(), contentType: "image/png" });
      });
    }
  });
});
