// M2 Vimeo in the room (OME-164, from the OME-126 review). Two halves:
// - the fake SDK (OME-121): canonical src, rate probe → seek-only, user pause → room pause, PrivacyError notice;
// - the real, pinned player.js (fixtures/vimeo-real-sdk): forged {event:"pause"} messages from the wrong origin or
//   source are dropped by the SDK, and the same event from our own iframe becomes a room pause.
// Runs in the `e2e-sync` project; each case shares a Vimeo video into a room of its own (OME-341).
import { expect, test } from "./support/csp";
import type { Frame, Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { FAKE_VIMEO_SDK, serveRealVimeoSdk } from "./support/network";
import { joinRoom, leaveAll, roomsFor, type Client } from "./support/room";
import { joinForToken, postShare } from "./support/share";
import { site } from "./support/selectors";
import { roomPlayback } from "../perf/sync";

const nextRoom = roomsFor("vimeo");
const VIMEO_ID = "76979871";
const REFUSED = "This video can't play here: the owner doesn't allow playback on other sites.";

/** window of fixtures/vimeo-real-sdk/embed.html, the player-side protocol stub. */
interface StubWindow { __methods: string[]; __emit: (event: string) => void }

test.describe.configure({ mode: "serial" });

const pair = (clients: readonly Client[]): [Client, Client] => {
  const [a, b] = clients;
  if (!a || !b) throw new Error("need two clients");
  return [a, b];
};

/** Share the Vimeo video into `roomId` before anyone joins, so every client mounts it. */
async function shareVimeo(request: Parameters<typeof postShare>[0], roomId: string): Promise<void> {
  const m = await joinForToken(roomId, "vimeo-sharer");
  try {
    expect((await postShare(request, roomId, m.token, `https://vimeo.com/${VIMEO_ID}`)).status()).toBe(200);
  } finally {
    m.close();
  }
}

async function waitFakePlaying(clients: readonly Client[]): Promise<void> {
  for (const c of clients) {
    await expect(c.page.locator(site.sharedVideo)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => c.page.evaluate(() => window.__fakeVimeo?.paused ?? null), { timeout: 15_000 }).toBe(false);
  }
}

const rateCalls = (page: Page): Promise<number> =>
  page.evaluate(() => window.__fakeVimeo?.calls.filter((c) => c.name === "setPlaybackRate").length ?? 0);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

test.describe("Vimeo in the room, fake SDK", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.setTimeout(90_000);

  test("our iframe has the canonical dnt=1 src, and a rejected rate probe leaves the player seek-only", async ({ browser, request }) => {
    const room = nextRoom();
    await shareVimeo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "vfake" });
    const [a] = pair(clients);
    await waitFakePlaying(clients);
    const src = new URL((await a.page.locator(site.sharedVideo).getAttribute("src")) ?? "");
    expect(`${src.origin}${src.pathname}`).toBe(`https://player.vimeo.com/video/${VIMEO_ID}`);
    expect(src.searchParams.get("dnt")).toBe("1");
    expect(await a.page.evaluate(() => window.__fakeVimeo?.src)).toBe(src.href);
    // The fake rejects setPlaybackRate by default: one probe, then only seeks, never a nudge.
    const probes = await a.page.evaluate(() => window.__fakeVimeo?.calls.filter((c) => c.name === "setPlaybackRate").map((c) => c.args) ?? []);
    expect(probes).toEqual([[1]]);
    await a.page.waitForTimeout(3000);
    expect(await rateCalls(a.page)).toBe(1);
  });

  test("a user pause inside the Vimeo player becomes a room pause, with the system line", async ({ browser, request }) => {
    const room = nextRoom();
    await shareVimeo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "vpause" });
    const [a, b] = pair(clients);
    await waitFakePlaying(clients);
    // Past the adapter's 1 s echo window for its own play.
    await a.page.waitForTimeout(2000);
    await a.page.evaluate(() => {
      window.__fakeVimeo?.userPause();
    });
    await expect.poll(() => b.page.evaluate(() => window.__fakeVimeo?.paused ?? null), { timeout: 5_000 }).toBe(true);
    await expect(b.page.locator(site.systemLine).last()).toHaveText(`${a.nickname} paused`);
    expect((await roomPlayback(browser, room.id)).playing).toBe(false);
  });

  test("PrivacyError shows the refused notice on that client only; the room keeps playing", async ({ browser, request }) => {
    const room = nextRoom();
    await shareVimeo(request, room.id);
    clients = await joinRoom(browser, {
      roomUrl: room.url,
      count: 2,
      nicknamePrefix: "vpriv",
      // Client 1's SDK refuses the video as Vimeo does for a domain-restricted embed.
      setup: async (context, i) => {
        if (i !== 0) return;
        await context.route("https://player.vimeo.com/api/player.js", (route) =>
          route.fulfill({ contentType: "text/javascript", body: `${FAKE_VIMEO_SDK}\nwindow.__fakeVimeo.privacy();` }),
        );
      },
    });
    const [a, b] = pair(clients);
    await expect(a.page.locator(site.syncNotice)).toHaveText(REFUSED, { timeout: 15_000 });
    await waitFakePlaying([b]);
    await expect(b.page.locator(site.syncNotice)).toBeHidden();
    expect((await roomPlayback(browser, room.id)).playing).toBe(true);
  });
});

test.describe("Vimeo in the room, real player.js: forged postMessage", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.setTimeout(90_000);

  test("a forged pause from the wrong origin or source is ignored; the same event from our iframe pauses the room", async ({ browser, request }) => {
    const room = nextRoom();
    await shareVimeo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "vreal", setup: serveRealVimeoSdk });
    const [a, b] = pair(clients);
    const frameFor = (id: string): Frame | undefined => a.page.frames().find((f) => f.url().startsWith(`https://player.vimeo.com/video/${id}`));
    const methods = async (): Promise<string> => (await frameFor(VIMEO_ID)?.evaluate(() => (window as unknown as StubWindow).__methods.join(","))) ?? "";
    // The real SDK drove the adapter through ready, the video check and the rate probe to play.
    await expect.poll(methods, { timeout: 15_000 }).toContain("play");
    expect(await methods()).toMatch(/^ping,.*getVideoId,setPlaybackRate,.*play/);
    await a.page.waitForTimeout(2000);
    expect((await roomPlayback(browser, room.id)).playing).toBe(true);
    const forged = JSON.stringify({ event: "pause", data: { seconds: 3, duration: 600, percent: 0.005 } });

    // 1. Wrong origin and wrong source: the page posting to itself.
    await a.page.evaluate((m) => {
      window.postMessage(m, "*");
    }, forged);
    // 2. Right origin (player.vimeo.com), wrong source: a second Vimeo frame that isn't ours.
    await a.page.evaluate(() => {
      const f = document.createElement("iframe");
      f.src = "https://player.vimeo.com/video/1234567";
      document.body.append(f);
    });
    await expect.poll(() => frameFor("1234567") !== undefined, { timeout: 5_000 }).toBe(true);
    const other = frameFor("1234567");
    if (!other) throw new Error("second Vimeo frame");
    await other.waitForFunction(() => "__emit" in window);
    await other.evaluate(() => {
      (window as unknown as StubWindow).__emit("pause");
    });
    // 3. Wrong origin: a cross-origin popup posting to its opener.
    const [popup] = await Promise.all([
      a.page.waitForEvent("popup"),
      a.page.evaluate(() => {
        window.open("https://evil.example/", "forger");
      }),
    ]);
    await popup.evaluate((m) => {
      (window.opener as Window | null)?.postMessage(m, "*");
    }, forged);
    await a.page.waitForTimeout(1500);
    expect((await roomPlayback(browser, room.id)).playing).toBe(true);
    await expect(b.page.locator(site.systemLine).filter({ hasText: "paused" })).toHaveCount(0);

    // Positive control: the same event from our own iframe is a user pause.
    await frameFor(VIMEO_ID)?.evaluate(() => {
      (window as unknown as StubWindow).__emit("pause");
    });
    await expect.poll(async () => (await roomPlayback(browser, room.id)).playing, { timeout: 5_000 }).toBe(false);
    await expect(b.page.locator(site.systemLine).last()).toHaveText(`${a.nickname} paused`);
  });
});
