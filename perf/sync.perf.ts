// sync.spread (docs/perf-budgets.md, Sync row; OME-90): 8 clients, max − min of (expected − actual) 2 s after each
// play / pause / seek, against the production build and the fake iframe_api. The metric is the worst action.
import { expect, test } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { joinRoom, leaveAll } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { recordMetric } from "./metrics";
import { SETTLE_MS, measureSpread, shareVideo, waitPlaying } from "./sync";

const CLIENTS = 8;
const ROUNDS = 2;

test("sync: spread after play/pause/seek, 8 clients", async ({ browser, request }) => {
  if (!available.web || !available.server) {
    recordMetric({ id: "sync.spread", pending: available.web ? PENDING.server : PENDING.web });
    return;
  }
  test.setTimeout(180_000);
  const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: CLIENTS, nicknamePrefix: "spread" });
  try {
    const [a] = clients;
    if (!a) throw new Error("no clients");
    await shareVideo(request);
    await waitPlaying(clients);
    const worst = { pause: 0, play: 0, seek: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const actions: [keyof typeof worst, () => Promise<void>][] = [
        ["pause", () => a.page.locator(site.playToggle).click()],
        ["play", () => a.page.locator(site.playToggle).click()],
        ["seek", () => a.page.locator(site.seek).fill(String(60 + round * 90))],
      ];
      for (const [action, act] of actions) {
        await act();
        await a.page.waitForTimeout(SETTLE_MS);
        const m = await measureSpread(browser, clients);
        expect(m.playback.action, `round ${String(round)}`).toBe(action);
        worst[action] = Math.max(worst[action], m.spreadMs);
      }
    }
    const value = Math.max(worst.pause, worst.play, worst.seek);
    const each = Object.entries(worst).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(" / ");
    recordMetric({ id: "sync.spread", value, note: `${each} ms, worst of ${String(ROUNDS)} rounds, ${String(CLIENTS)} clients, fake player` });
  } finally {
    await leaveAll(clients);
  }
});
