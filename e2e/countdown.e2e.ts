// The shared 3-2-1 (OME-1634, ADR 0056): a play from paused shows 3, 2, 1 on every client and the room starts at the
// playback's startAt, every client within the sync budget; a pause during the countdown cancels it for everyone.
import { expect, test } from "./support/csp";
import { COUNTDOWN_MS } from "@omega/shared";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { PAUSED, PLAYING, SETTLE_MS, SPREAD_BUDGET_MS, fakeState, measureSpread, roomPlayback, shareVideo, waitPlaying } from "../perf/sync";

test.describe.configure({ mode: "parallel" });

const pair = (clients: readonly Client[]): [Client, Client] => {
  const [a, b] = clients;
  if (!a || !b) throw new Error("need two clients");
  return [a, b];
};

/** Both clients paused, the room too. */
async function pausedRoom(clients: readonly Client[], a: Client): Promise<void> {
  await a.page.locator(site.playToggle).click();
  for (const c of clients) await expect.poll(() => fakeState(c.page), { message: `${c.nickname} paused` }).toBe(PAUSED);
}

test.describe("shared countdown, 2 clients", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.setTimeout(60_000);

  let clients: Client[] = [];
  test.afterEach(async () => {
    await leaveAll(clients);
    clients = [];
  });

  test("play from paused: 3-2-1 on both, then both start within the budget", async ({ browser, request }, info) => {
    const room = testRoom("countdown", "start");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "cd" });
    const [a, b] = pair(clients);
    await waitPlaying(clients);
    await pausedRoom(clients, a);

    await b.page.locator(site.playToggle).click();
    for (const c of clients) await expect(c.page.locator(site.countdown), c.nickname).toHaveText(/^[321]$/);
    const counting = await roomPlayback(browser, room.id);
    expect(counting.startAt).toBe(counting.at + COUNTDOWN_MS);
    // Held at the position until startAt.
    for (const c of clients) expect(await fakeState(c.page)).toBe(PAUSED);

    for (const c of clients) await expect(c.page.locator(site.countdown), c.nickname).toBeHidden({ timeout: COUNTDOWN_MS + 2000 });
    await a.page.waitForTimeout(SETTLE_MS);
    for (const c of clients) expect(await fakeState(c.page)).toBe(PLAYING);
    const m = await measureSpread(browser, clients, room.id);
    await info.attach("spread", { body: JSON.stringify(m, null, 2), contentType: "application/json" });
    expect(m.playback.rev).toBe(counting.rev);
    expect(m.spreadMs, `drifts ${m.drifts.map((d) => d.toFixed(0)).join(", ")} ms`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
  });

  test("a pause during the countdown cancels it for everyone", async ({ browser, request }) => {
    const room = testRoom("countdown", "cancel");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "cdx" });
    const [a, b] = pair(clients);
    await waitPlaying(clients);
    await pausedRoom(clients, a);

    await a.page.locator(site.playToggle).click();
    await expect(b.page.locator(site.countdown)).toBeVisible();
    await b.page.locator(site.playToggle).click();
    for (const c of clients) await expect(c.page.locator(site.countdown), c.nickname).toBeHidden();
    await a.page.waitForTimeout(COUNTDOWN_MS + 500);
    for (const c of clients) expect(await fakeState(c.page)).toBe(PAUSED);
    const p = await roomPlayback(browser, room.id);
    expect([p.playing, p.startAt]).toEqual([false, undefined]);
  });
});
