// Opt-in real Twitch / Vimeo checks for the M2 sign-off (OME-133): `bun run e2e:real`. Real network, headed, never in CI.
// Checklist and how to read the results: docs/qa/m2-real-sign-off.md. Evidence: e2e/real/results/m2-<item>.json (+ .png).
// The fake-SDK suites (e2e/provider-sync.e2e.ts, e2e/vimeo.e2e.ts) prove the logic; this proves the real players obey it.
import { chromium } from "@playwright/test";
import { expect, test, watchCsp } from "../support/csp";
import type { APIRequestContext, Browser, Frame } from "@playwright/test";
import { site } from "../support/selectors";
import { REAL, arrival, mediaSpread, providerFrame, sampleMedia, seekTo, siteNotices, twitchLiveUrl, twitchVodUrl, view, vimeoUrl, waitMediaPlaying } from "./providers";
import type { MediaSample, RealProvider } from "./providers";
import { closeAll, enter, record, requireVirtualDisplay, shareUrl, shot } from "./real";
import type { Client } from "./real";

test.beforeAll(requireVirtualDisplay);

/** docs/perf-budgets.md, Sync row. */
const SPREAD_BUDGET_MS = 500;

test.setTimeout(300_000);

/** Two Chromium processes with their own profiles (the "2+ browsers" of the checklist), each in the lobby. */
async function twoBrowsers(prefix: string): Promise<{ browsers: Browser[]; a: Client; b: Client }> {
  const browsers = [await chromium.launch({ headless: false }), await chromium.launch({ headless: false })];
  const [one, two] = browsers;
  if (one === undefined || two === undefined) throw new Error("no browsers");
  const a = await enter(await watchCsp(await one.newContext()), `${prefix}-1`);
  const b = await enter(await watchCsp(await two.newContext()), `${prefix}-2`);
  return { browsers, a, b };
}

async function frames(a: Client, b: Client, provider: RealProvider, id: string): Promise<[Frame, Frame]> {
  return [await providerFrame(a.page, provider, id), await providerFrame(b.page, provider, id)];
}

interface LiveTry { readonly channel: string; readonly outcome: "live" | "offline" | "error" | "no-start" }

/**
 * Shares the first candidate that is live now (OME-218: a fixed channel is often offline). Offline is the room's
 * `offline` error with the new player's own offline overlay (so a stale error from the last candidate can't count);
 * an ad or moving video means live. Another error, or nothing within `perChannel`, tries the next, until `budget`
 * runs out, which leaves the test (300 s) time to run.
 */
async function shareLiveChannel(request: APIRequestContext, a: Client, candidates: readonly string[], perChannel = 25_000, budget = 120_000): Promise<{ channel: string | null; tried: LiveTry[] }> {
  const tried: LiveTry[] = [];
  const start = Date.now();
  for (const channel of candidates) {
    if (Date.now() - start > budget) break;
    await shareUrl(request, twitchLiveUrl(channel));
    const frame = await providerFrame(a.page, "twitch", channel, 15_000).catch(() => null);
    let outcome: LiveTry["outcome"] = "no-start";
    const t0 = Date.now();
    while (frame !== null && Date.now() - t0 < perChannel) {
      const [s, v] = await Promise.all([sampleMedia(frame), view(a.page)]);
      if (v !== null && v.error !== null && v.error.reason !== "offline") {
        outcome = "error";
        break;
      }
      if (v?.error?.reason === "offline" && s !== null && /offline/i.test(s.overlay)) {
        outcome = "offline";
        break;
      }
      if (s !== null && (s.ad || (!s.paused && s.currentTime > 0.5))) {
        outcome = "live";
        break;
      }
      await a.page.waitForTimeout(500);
    }
    tried.push({ channel, outcome });
    if (outcome === "live") return { channel, tried };
  }
  return { channel: null, tried };
}

const seekable: { key: string; provider: RealProvider; url: string; frameId: string }[] = [
  { key: "twitch-vod", provider: "twitch", url: twitchVodUrl(REAL.twitchVod), frameId: `v${REAL.twitchVod}` },
  { key: "vimeo", provider: "vimeo", url: vimeoUrl(REAL.vimeo), frameId: REAL.vimeo },
];

for (const c of seekable) {
  test(`M2-${c.key} · play / pause / seek shared across two browsers: spread ≤ 500 ms`, async ({ request }) => {
    const { browsers, a, b } = await twoBrowsers(`real-${c.key}`);
    try {
      await shareUrl(request, c.url);
      const [fa, fb] = await frames(a, b, c.provider, c.frameId);
      const ads = await Promise.all([waitMediaPlaying(a, fa), waitMediaPlaying(b, fb)]);
      await a.page.waitForTimeout(5_000);
      const va = await view(a.page);
      const steady = await mediaSpread(fa, fb, 16, 500);

      await a.page.locator(site.playToggle).click();
      await a.page.waitForTimeout(2_500);
      const paused = await Promise.all([sampleMedia(fa), sampleMedia(fb)]);
      const pausedViews = await Promise.all([view(a.page), view(b.page)]);

      await a.page.locator(site.playToggle).click();
      await a.page.waitForTimeout(3_000);
      const afterPlay = await mediaSpread(fa, fb, 10, 250);

      const target = 300;
      const seekAt = Date.now();
      await seekTo(a.page, target);
      await a.page.waitForTimeout(4_000);
      const seeked = await Promise.all([sampleMedia(fa), sampleMedia(fb)]);
      /** How far a player is behind the room clock (target + time since the seek), at that sample's own time. */
      const lag = (s: MediaSample | null): number | null => (s === null ? null : Math.round((target + (s.t - seekAt) / 1000 - s.currentTime) * 1000));
      const afterSeek = await mediaSpread(fa, fb, 10, 250);
      // Buffering after a seek puts both behind the room clock for a moment; the sync loop must bring them back.
      await a.page.waitForTimeout(6_000);
      const later = await Promise.all([sampleMedia(fa), sampleMedia(fb)]);
      const lagMs = later.map(lag);
      await Promise.all([shot(a.page, `m2-${c.key}-1`), shot(b.page, `m2-${c.key}-2`)]);

      const pausedDiffMs = paused[0] && paused[1] ? Math.round((paused[0].currentTime - paused[1].currentTime) * 1000) : null;
      const result = {
        url: c.url,
        plate: await a.page.locator('[data-testid="provider-plate"]').textContent(),
        seekOnly: va?.seekOnly ?? null,
        live: va?.live ?? null,
        videoRates: (await Promise.all([sampleMedia(fa), sampleMedia(fb)])).map((s) => s?.playbackRate ?? null),
        adsBeforeContent: ads.map((x) => ({ samples: x.length, roomAlwaysPlaying: x.every((s) => s.roomPlaying !== false), catchingSeen: x.some((s) => s.catching === true) })),
        steady,
        paused: { bothPaused: paused.every((p) => p?.paused === true), pausedDiffMs, roomPlaying: pausedViews.map((v) => v?.playing ?? null) },
        afterPlay,
        seek: { target, positions: seeked.map((s) => s?.currentTime ?? null), lagBehindRoomMs4s: seeked.map(lag), afterSeek, lagBehindRoomMs10s: lagMs },
        notices: await siteNotices(a.page),
      };
      record(`m2-${c.key}`, result);
      expect(result.live, "not live").toBe(false);
      expect(steady.samplesMs.length, "steady samples").toBeGreaterThan(5);
      expect(steady.maxAbsMs).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
      expect(result.paused.bothPaused, "a pause from browser 1 pauses browser 2's real player").toBe(true);
      expect(Math.abs(pausedDiffMs ?? Infinity)).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
      expect(afterPlay.maxAbsMs).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
      // Both really moved to the seek target (so <video>.currentTime is the media position, not an MSE timeline).
      for (const l of result.seek.lagBehindRoomMs4s) expect(Math.abs(l ?? Infinity), "near the seek target 4 s after it").toBeLessThan(5_000);
      for (const l of lagMs) expect(Math.abs(l ?? Infinity), "caught up with the room clock 10 s after the seek").toBeLessThan(1_000);
      expect(afterSeek.maxAbsMs).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    } finally {
      await closeAll(...browsers);
    }
  });
}

test("M2-twitch-live · pause and play-from-live reach both browsers; no scrubber; ads as found", async ({ request }) => {
  const { browsers, a, b } = await twoBrowsers("real-live");
  try {
    const live = await shareLiveChannel(request, a, REAL.twitchLive);
    const { channel } = live;
    if (channel === null) {
      record("m2-twitch-live", { notRun: "no candidate was live; set OMEGA_REAL_TWITCH_LIVE", tried: live.tried });
      test.skip(true, `no Twitch candidate is live now (${live.tried.map((x) => `${x.channel}: ${x.outcome}`).join(", ")}); set OMEGA_REAL_TWITCH_LIVE`);
      return;
    }
    const [fa, fb] = await frames(a, b, "twitch", channel);
    const ads = await Promise.all([waitMediaPlaying(a, fa), waitMediaPlaying(b, fb)]);
    await a.page.waitForTimeout(3_000);
    const va = await view(a.page);
    const chrome = {
      live: va?.live ?? null,
      livePill: await a.page.locator('[data-testid="live-pill"]').isVisible(),
      seekVisible: await a.page.locator(site.seek).isVisible(),
    };

    const pauseAt = Date.now();
    await a.page.locator(site.playToggle).click();
    const pauseArrival = await arrival([fa, fb], true, pauseAt);
    await a.page.waitForTimeout(2_000);
    const playAt = Date.now();
    await a.page.locator(site.playToggle).click();
    const playArrival = await arrival([fa, fb], false, playAt, 10_000);
    await a.page.waitForTimeout(3_000);
    const final = await Promise.all([sampleMedia(fa), sampleMedia(fb)]);
    await Promise.all([shot(a.page, "m2-twitch-live-1"), shot(b.page, "m2-twitch-live-2")]);
    const spread = (xs: (number | null)[]): number | null => (xs.every((x) => x !== null) ? Math.max(...(xs)) - Math.min(...(xs)) : null);
    const result = {
      channel,
      tried: live.tried,
      chrome,
      adsBeforeContent: ads.map((x) => ({ samples: x.length, roomAlwaysPlaying: x.every((s) => s.roomPlaying !== false), catchingSeen: x.some((s) => s.catching === true) })),
      pause: { arrivalMs: pauseArrival, spreadMs: spread(pauseArrival) },
      play: { arrivalMs: playArrival, spreadMs: spread(playArrival) },
      finalPlaying: final.map((s) => (s === null ? null : !s.paused)),
      notices: await siteNotices(a.page),
    };
    record("m2-twitch-live", result);
    expect(chrome.live).toBe(true);
    expect(chrome.seekVisible, "no scrubber on live").toBe(false);
    expect(pauseArrival.every((x) => x !== null), "both real players paused").toBe(true);
    expect(playArrival.every((x) => x !== null), "both real players resumed").toBe(true);
    // The live spread budget is board question B1 (ADR 0014): recorded, only a sanity bound here.
    expect(result.pause.spreadMs ?? Infinity).toBeLessThan(2_000);
  } finally {
    await closeAll(...browsers);
  }
});

test("M2-refused · refused, gone, offline and mature-gated embeds: the site says why and freezes the transport", async ({ browser, request }) => {
  const a = await enter(await watchCsp(await browser.newContext()), "real-refused");
  interface Case { url: string; played: boolean; ad: boolean; overlay: string; siteNotices: string[]; playing: boolean | null; canControl: boolean | null; error: unknown }
  const cases: (readonly [name: string, provider: RealProvider, url: string, frameId: string])[] = [
    ["vimeo-gone", "vimeo", vimeoUrl(REAL.vimeoGone), REAL.vimeoGone],
    ["twitch-vod-gone", "twitch", twitchVodUrl("1"), "v1"],
    ["twitch-no-such-channel", "twitch", twitchLiveUrl(REAL.twitchNoSuchChannel), REAL.twitchNoSuchChannel],
    ["twitch-offline", "twitch", twitchLiveUrl(REAL.twitchOffline), REAL.twitchOffline],
    ["twitch-mature", "twitch", twitchLiveUrl(REAL.twitchMature), REAL.twitchMature],
    ...(REAL.vimeoRefused === undefined ? [] : [["vimeo-refused", "vimeo", vimeoUrl(REAL.vimeoRefused), REAL.vimeoRefused] as const]),
  ];
  const results: Record<string, Case> = {};
  try {
    for (const [name, provider, url, frameId] of cases) {
      await shareUrl(request, url);
      const frame = await providerFrame(a.page, provider, frameId).catch(() => null);
      await a.page.waitForTimeout(15_000);
      const s = frame === null ? null : await sampleMedia(frame);
      const v = await view(a.page);
      await shot(a.page, `m2-refused-${name}`);
      results[name] = {
        url,
        played: s !== null && !s.paused && !s.ad && s.currentTime > 1,
        ad: s?.ad ?? false,
        overlay: s?.overlay ?? "(no frame)",
        siteNotices: await siteNotices(a.page),
        playing: v?.playing ?? null,
        canControl: v?.canControl ?? null,
        error: v?.error ?? null,
      };
    }
    const notRun = REAL.vimeoRefused === undefined ? ["vimeo-refused: set OMEGA_REAL_VIMEO_REFUSED to a domain-restricted id"] : [];
    const mature = results["twitch-mature"];
    // Ungated: Twitch's own <video> played the stream (or its pre-roll) with no gate showing, so it refused nothing (OME-218).
    const ungated = mature !== undefined && (mature.played || mature.ad) && !/mature|audience|gate/i.test(mature.overlay);
    if (ungated) notRun.push(`twitch-mature: ${REAL.twitchMature} played with no mature gate for a logged-out viewer; set OMEGA_REAL_TWITCH_MATURE to a gated channel`);
    record("m2-refused", { notRun, results });
    for (const [name, x] of Object.entries(results)) {
      if (x.played || (name === "twitch-mature" && ungated)) continue;
      expect.soft(x.siteNotices.some((t) => /can.t play|offline|unavailable|restricted|didn.t start/i.test(t)), `${name}: the site says why`).toBe(true);
      expect.soft(x.canControl, `${name}: the transport is frozen`).toBe(false);
    }
  } finally {
    await a.context.close();
  }
});
