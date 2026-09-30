// M1a sign-off (OME-9): share from the extension → 4 site clients see the embed, each other seated with nickname tags,
// and a chat bubble. Plus the negative checks: non-YouTube share → 400, 9th sitter can't sit, 26th arrival sees "Room full".
// Serial: every test shares the server's one in-memory lobby.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { DEFAULT_ROOM_ID, MAX_ROOM_MEMBERS, SEAT_COUNT, parseServerMessage, type RoomState } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { rawSnapshot, spawnBots } from "./support/bots";
import { expect, test } from "./support/extension";
import { EMBED_URL, VIDEO_ID, gotoFixture, stubExternalNetwork } from "./support/network";
import { clickSettled } from "./support/room";
import { popup, site } from "./support/selectors";

const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;
const SHARE_URL = `${URLS.server}/rooms/${DEFAULT_ROOM_ID}/share`;

interface SiteClient {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly nickname: string;
}

/** Opens the room as a new person. Doesn't wait for the stage: a full room never shows it. */
async function arrive(browser: Browser, nickname: string, avatar: number): Promise<SiteClient> {
  const context = await browser.newContext();
  await stubExternalNetwork(context);
  const page = await context.newPage();
  await page.goto(ROOM_URL);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(`${site.avatarOption}[data-avatar="${String(avatar)}"]`).click();
  await page.locator(site.joinButton).click();
  return { context, page, nickname };
}

/** The server's view of the lobby, parsed at the boundary. */
async function serverRoom(browser: Browser): Promise<RoomState> {
  const msg = parseServerMessage(await rawSnapshot(browser, DEFAULT_ROOM_ID));
  if (msg?.type !== "snapshot") throw new Error("expected a snapshot");
  return msg.room;
}

const seat = (page: Page, i: number) => page.locator(`${site.seat}[data-seat="${String(i)}"]`);

test.describe.configure({ mode: "serial" });

test.describe("M1a acceptance", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.fixme(!available.extension, PENDING.extension);

  test("share from the extension; 4 people see the embed, each other seated, and chat", async ({ browser, context, openPopup }, info) => {
    test.setTimeout(60_000);

    await test.step("1. popup lists the fixture embed in canonical form and shares it to the default room", async () => {
      const tab = await context.newPage();
      await gotoFixture(tab, "youtube-embed");
      const p = await openPopup(tab);
      await expect(p.locator(popup.embedItem)).toHaveCount(1);
      await expect(p.locator(popup.embedItem)).toHaveAttribute("data-video-id", VIDEO_ID);
      await expect(p.locator(`${popup.embedItem} input[name=embed]`)).toHaveValue(EMBED_URL);
      await expect(p.locator(popup.roomSelect)).toHaveValue(DEFAULT_ROOM_ID);
      await p.locator(popup.shareButton).click();
      await expect(p.locator(popup.shareStatus)).toHaveAttribute("data-state", "ok");
      await info.attach("popup-shared", { body: await p.screenshot(), contentType: "image/png" });
    });

    // Mixed avatars with a duplicate (0 twice).
    const people = [
      { nickname: "ada", avatar: 0 },
      { nickname: "bo", avatar: 1 },
      { nickname: "cy", avatar: 2 },
      { nickname: "dee", avatar: 0 },
    ];
    const clients = await test.step("2a. 4 contexts enter the room", () =>
      Promise.all(people.map((p) => arrive(browser, p.nickname, p.avatar))),
    );
    try {
      await test.step("2b. each sits in a different seat", async () => {
        for (const c of clients) await expect(c.page.locator(site.room)).toBeVisible();
        await Promise.all(
          clients.map(async (c, i) => {
            await expect(seat(c.page, i)).toBeEnabled();
            await clickSettled(c.page, seat(c.page, i));
            await expect(seat(c.page, i)).toHaveClass(/\bmine\b/);
          }),
        );
      });

      const line = "hello from OME-9";
      await test.step("2c. one sends a chat message", async () => {
        const first = clients[0];
        if (first === undefined) throw new Error("no clients");
        await first.page.locator(site.chatInput).fill(line);
        await first.page.locator(site.chatInput).press("Enter");
      });

      await test.step("3. all 4 see the canonical embed, every seated avatar with its tag, and the bubble", async () => {
        for (const c of clients) {
          const tv = c.page.locator(site.sharedVideo);
          await expect(tv).toHaveCount(1);
          const src = new URL((await tv.getAttribute("src")) ?? "");
          // The room stores the canonical www URL; tvFrame() renders it on the nocookie host with the IFrame API params (OME-88).
          expect(`${src.origin}${src.pathname}`).toBe(`https://www.youtube-nocookie.com/embed/${VIDEO_ID}`);
          expect(src.searchParams.get("enablejsapi")).toBe("1");
          expect(src.searchParams.get("origin")).toBe(new URL(c.page.url()).origin);
          await expect(c.page.locator("iframe")).toHaveCount(1);

          // Tags follow join order, which is racy here; compare as a set.
          await expect(c.page.locator(site.nicknameTag)).toHaveCount(people.length);
          expect((await c.page.locator(site.nicknameTag).allInnerTexts()).toSorted()).toEqual(people.map((p) => p.nickname).toSorted());
          for (const [i, p] of people.entries()) {
            await expect(seat(c.page, i)).toHaveAttribute("data-occupied", "true");
            if (c.nickname !== p.nickname) await expect(seat(c.page, i)).toHaveAttribute("aria-label", `Seat ${String(i + 1)}, taken by ${p.nickname}`);
          }
          await expect(c.page.locator(`${site.seat}[data-occupied="true"]`)).toHaveCount(people.length);
          await expect(c.page.locator(site.chatMessage)).toHaveText([line]);
        }
        for (const c of clients) await info.attach(`room-${c.nickname}`, { body: await c.page.screenshot(), contentType: "image/png" });
      });

      await test.step("3b. server state: avatars as picked (duplicate kept), seats as clicked", async () => {
        const room = await serverRoom(browser);
        const byName = new Map(room.members.map((m) => [m.nickname, m]));
        for (const [i, p] of people.entries()) {
          const m = byName.get(p.nickname);
          expect(m?.avatar).toBe(p.avatar);
          expect(room.seats[i]).toBe(m?.id);
        }
        expect(room.embed?.url).toBe(EMBED_URL);
      });
    } finally {
      await Promise.all(clients.map((c) => c.context.close()));
    }
  });

  test("4a. a page with only non-allowlisted iframes has nothing to share", async ({ context, openPopup }) => {
    const tab = await context.newPage();
    await gotoFixture(tab, "non-allowlisted");
    const p = await openPopup(tab);
    await expect(p.locator(popup.embedsEmpty)).toBeVisible();
    await expect(p.locator(popup.embedItem)).toHaveCount(0);
    await expect(p.locator(popup.shareButton)).toBeHidden();
  });

  test("4b. direct POST of a non-YouTube URL → 400, room embed unchanged", async ({ browser, request }) => {
    for (const url of ["https://vimeo.com/76979871", "https://www.youtube.com.evil.test/embed/aqz-KE-bpKQ", "javascript:alert(1)"]) {
      // The per-IP share limiter (5 burst, 1 per 3 s) runs before validation; wait out a 429 from earlier shares.
      let res = await request.post(SHARE_URL, { data: { url } });
      await expect
        .poll(async () => {
          if (res.status() === 429) res = await request.post(SHARE_URL, { data: { url } });
          return res.status();
        }, { timeout: 15_000, intervals: [1_000] })
        .not.toBe(429);
      expect(res.status(), url).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "unsupported_url" } });
    }
    expect((await serverRoom(browser)).embed?.url).toBe(EMBED_URL);
  });

  test("4c. with all 8 seats taken, a 9th person cannot sit", async ({ browser }) => {
    const bots = await spawnBots(browser, DEFAULT_ROOM_ID, Array.from({ length: SEAT_COUNT }, (_, i) => ({ nickname: `sitter-${String(i + 1)}`, seat: i })));
    const ninth = await arrive(browser, "ninth", 3);
    try {
      expect(bots.joined).toBe(SEAT_COUNT);
      const page = ninth.page;
      await expect(page.locator(site.room)).toBeVisible();
      await expect(page.locator(`${site.seat}[data-occupied="true"]`)).toHaveCount(SEAT_COUNT);
      for (let i = 0; i < SEAT_COUNT; i++) {
        await clickSettled(page, seat(page, i));
        await expect(seat(page, i)).toHaveAttribute("aria-label", `Seat ${String(i + 1)}, taken by sitter-${String(i + 1)}`);
      }
      await expect(page.locator(`${site.seat}.mine`)).toHaveCount(0);
      const room = await serverRoom(browser);
      const ninthId = room.members.find((m) => m.nickname === "ninth")?.id;
      expect(ninthId).toBeDefined();
      expect(room.seats).not.toContain(ninthId);
    } finally {
      await ninth.context.close();
      await bots.close();
    }
  });

  test(`4d. room full: arrival #${String(MAX_ROOM_MEMBERS + 1)} sees "Room full" and no stage`, async ({ browser }, info) => {
    const bots = await spawnBots(browser, DEFAULT_ROOM_ID, Array.from({ length: MAX_ROOM_MEMBERS + 5 }, (_, i) => ({ nickname: `filler-${String(i + 1)}` })));
    try {
      expect(bots.sawRoomFull).toBe(true);
      const late = await arrive(browser, "latecomer", 1);
      try {
        await expect(late.page.locator(site.roomFull)).toBeVisible();
        await expect(late.page.locator(site.roomFull)).toContainText("This room is full");
        await expect(late.page.locator(site.room)).toBeHidden();
        await expect(late.page.locator(site.chatInput)).toBeHidden();
        await info.attach("room-full", { body: await late.page.screenshot(), contentType: "image/png" });
      } finally {
        await late.context.close();
      }
    } finally {
      await bots.close();
    }
  });
});
