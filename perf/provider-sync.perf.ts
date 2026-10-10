// M2 per-provider budgets (OME-131), against the production build and the fake SDKs (OME-121):
// - sync.spread.<provider>: as sync.perf.ts, 8 clients, 4 rounds of pause / play / seek, 2 s after each; per action the
//   upper median of its rounds, the worst action is the row (OME-846).
//   Twitch live has no position (ADR 0014 §3): first-to-last client applying a pause / play-from-live, same rule,
//   acting as soon as every client plays, like a user right after joining (OME-170).
// - site.frameP95.twitch* (+ ADR 0017's frameWorkP95 / missedVsync rows): as site.perf.ts, 8 avatars with a Twitch VOD or live stream playing (Vimeo's rows are there).
import { expect, test } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { joinRoom, leaveAll, type Client } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { recordFrameRows, sampledFrames } from "./frames";
import { recordMetric } from "./metrics";
import { spreadVerdict } from "./spread";
import { fakePlaying, measureLiveArrival, measureProviderSpread, providerCase, shareProvider, waitProviderPlaying, type ProviderCase } from "./providers";
import { SETTLE_MS } from "./sync";

const CLIENTS = 8;
/** 4 rounds, each action's upper median: one slow round of a bimodal spread can't flip the row (OME-846). */
const ROUNDS = 4;
const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;

const pending = (): string | null => (!available.web ? PENDING.web : !available.server ? PENDING.server : null);

async function joinPlaying(browser: Browser, c: ProviderCase, prefix: string): Promise<Client[]> {
  const clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: CLIENTS, nicknamePrefix: prefix });
  await waitProviderPlaying(clients, c.provider);
  return clients;
}

for (const key of ["twitchVod", "vimeo"] as const) {
  test(`sync: spread after play/pause/seek, 8 clients, ${key}`, async ({ browser, request }) => {
    const id = `sync.spread.${key}`;
    const why = pending();
    if (why !== null) {
      recordMetric({ id, pending: why });
      return;
    }
    test.setTimeout(180_000);
    const c = providerCase(key);
    await shareProvider(request, c.shareUrl);
    const clients = await joinPlaying(browser, c, `spread-${key}`);
    try {
      const [a] = clients;
      if (!a) throw new Error("no clients");
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
          const m = await measureProviderSpread(browser, clients, c.provider);
          expect(m.playback.action, `round ${String(round)}`).toBe(action);
          rounds[action].push(m.spreadMs);
        }
      }
      const v = spreadVerdict(rounds);
      const mode = key === "vimeo" ? "rate rejected → seek-only" : "no rate → seek-only";
      recordMetric({ id, value: v.value, note: `${v.note}, ${String(CLIENTS)} clients, fake SDK, ${mode}` });
    } finally {
      await leaveAll(clients);
    }
  });
}

test("sync: spread after pause/play-from-live, 8 clients, twitchLive", async ({ browser, request }) => {
  const id = "sync.spread.twitchLive";
  const why = pending();
  if (why !== null) {
    recordMetric({ id, pending: why });
    return;
  }
  test.setTimeout(180_000);
  const c = providerCase("twitchLive");
  await shareProvider(request, c.shareUrl);
  const clients = await joinPlaying(browser, c, "spread-live");
  try {
    const [a] = clients;
    if (!a) throw new Error("no clients");
    const rounds: Record<"pause" | "play", number[]> = { pause: [], play: [] };
    let latencyMs = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const pause = await measureLiveArrival(clients, "pause", () => a.page.locator(site.playToggle).click());
      await waitProviderPlaying(clients, c.provider, false);
      const play = await measureLiveArrival(clients, "play", () => a.page.locator('[data-testid="to-live"]').click());
      await waitProviderPlaying(clients, c.provider);
      for (const [k, r] of [["pause", pause], ["play", play]] as const) {
        rounds[k].push(r.spreadMs);
        latencyMs = Math.max(latencyMs, r.latencyMs);
      }
    }
    const v = spreadVerdict(rounds);
    recordMetric({ id, value: v.value, note: `${v.note}, first-to-last client (last client at most +${latencyMs.toFixed(0)} ms), ${String(CLIENTS)} clients, fake SDK` });
  } finally {
    await leaveAll(clients);
  }
});

for (const key of ["twitchVod", "twitchLive"] as const) {
  test(`site: p95 frame time with 8 avatars and ${key} playing`, async ({ browser, request }) => {
    const why = pending();
    if (why !== null) {
      for (const id of [`site.frameP95.${key}`, `site.frameWorkP95.${key}`, `site.missedVsync.${key}`]) recordMetric({ id, pending: why });
      return;
    }
    test.setTimeout(120_000);
    const c = providerCase(key);
    await shareProvider(request, c.shareUrl);
    const clients = await joinPlaying(browser, c, `fps-${key}`);
    try {
      const [observer] = clients;
      if (!observer) throw new Error("no clients");
      const ws = await sampledFrames(browser, observer.page, 5000);
      expect(await fakePlaying(observer.page, c.provider)).toBe(true);
      for (const w of ws) expect(w.samples.length).toBeGreaterThan(0);
      recordFrameRows(key, ws, `${c.label} playing (fake SDK)`);
    } finally {
      await leaveAll(clients);
    }
  });
}
