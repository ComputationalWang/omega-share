// sync.spread (docs/perf-budgets.md, Sync row; OME-90): 8 clients, max − min of (expected − actual) 2 s after each
// play / pause / seek, against the production build and the fake iframe_api. 4 rounds; per action the upper median of
// its rounds, and the metric is the worst action (OME-846).
import { expect, test } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { joinRoom, leaveAll } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { recordMetric } from "./metrics";
import { spreadVerdict } from "./spread";
import { SETTLE_MS, measureSpread, shareVideo, waitPlaying } from "./sync";

const CLIENTS = 8;
/** 4 rounds, each action's upper median: one slow round of a bimodal spread can't flip the row (OME-846). */
const ROUNDS = 4;

test("sync: spread after play/pause/seek, 8 clients", async ({ browser, request }) => {
  if (!available.web || !available.server) {
    recordMetric({ id: "sync.spread", pending: available.web ? PENDING.server : PENDING.web });
    return;
  }
  test.setTimeout(180_000);
  // Share before joining, so every client is on this video, not a previous spec's.
  await shareVideo(request);
  const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: CLIENTS, nicknamePrefix: "spread" });
  try {
    const [a] = clients;
    if (!a) throw new Error("no clients");
    await waitPlaying(clients);
    const rounds: Record<"pause" | "play" | "seek", number[]> = { pause: [], play: [], seek: [] };
    for (let round = 0; round < ROUNDS; round++) {
      const actions: [keyof typeof rounds, () => Promise<void>][] = [
        ["pause", () => a.page.locator(site.playToggle).click()],
        ["play", () => a.page.locator(site.playToggle).click()],
        ["seek", () => a.page.locator(site.seek).fill(String(60 + round * 90))],
      ];
      for (const [action, act] of actions) {
        await act();
        await a.page.waitForTimeout(SETTLE_MS);
        const m = await measureSpread(browser, clients);
        expect(m.playback.action, `round ${String(round)}`).toBe(action);
        rounds[action].push(m.spreadMs);
      }
    }
    const v = spreadVerdict(rounds);
    recordMetric({ id: "sync.spread", value: v.value, note: `${v.note}, ${String(CLIENTS)} clients, fake player` });
  } finally {
    await leaveAll(clients);
  }
});
