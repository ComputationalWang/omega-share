// Opt-in real Twitch / Vimeo checks for the M2 sign-off (OME-133): `bun run e2e:real`. Real network, headed, never in CI.
// Checklist and how to read the results: docs/qa/m2-real-sign-off.md. Evidence: e2e/real/results/m2-<item>.json (+ .png).
// The fake-SDK suites (e2e/provider-sync.e2e.ts, e2e/vimeo.e2e.ts) prove the logic; this proves the real players obey it.
import { writeFileSync } from "node:fs";
import { discoverPairedGate, collectGateEvidence, runGateWorkflow } from "./twitch-gate";
import { discoverPairedLive } from "./twitch-live";
import { chromium } from "@playwright/test";
import { expect, test, watchCsp } from "../support/csp";
import type { Browser, Frame } from "@playwright/test";
import { site } from "../support/selectors";
import { REAL, TWITCH_START_WATCHING, arrival, gateShown, liveInCategories, mediaSpread, providerFrame, sampleMedia, seekTo, siteNotices, twitchLiveUrl, twitchVodUrl, view, vimeoUrl, waitMediaPlaying } from "./providers";
import type { MediaSample, RealProvider } from "./providers";
import { closeAll, enter, record, requireVirtualDisplay, shareUrl, shot } from "./real";
import type { Client } from "./real";

test.beforeAll(requireVirtualDisplay);

/** docs/perf-budgets.md, Sync row. Checked on offsets held for two samples in a row: ./spread.ts (OME-377). */
const SPREAD_BUDGET_MS = 500;
/** Real Twitch live play-from-live: a sanity bound, not the Sync budget (ADR 0048, OME-1057). */
const LIVE_PLAY_SANITY_MS = 2_000;

test.setTimeout(300_000);

/** One raw Twitch SDK event as the page received it: wall-clock ms, the iframe's eventName, and playback on state pushes. */
interface SdkEvent { readonly t: number; readonly event: string; readonly playback?: string }

declare global {
  interface Window { __twitchSdkLog?: SdkEvent[] }
}

/**
 * Logs the Twitch iframe's postMessages (the SDK's only input: events on namespace "twitch-embed*", research M2 §2)
 * into window.__twitchSdkLog. UPDATE_STATE is kept only when its playback changes. Runs before the site's scripts.
 */
function logTwitchSdk(): void {
  const log: SdkEvent[] = [];
  window.__twitchSdkLog = log;
  let playback = "";
  addEventListener("message", (ev: MessageEvent<unknown>) => {
    const d = ev.data;
    if (log.length >= 1000 || typeof d !== "object" || d === null || !("namespace" in d) || !("eventName" in d)) return;
    if (typeof d.namespace !== "string" || !d.namespace.startsWith("twitch-embed") || typeof d.eventName !== "string") return;
    const p = "params" in d && typeof d.params === "object" && d.params !== null && "playback" in d.params ? d.params.playback : undefined;
    const pb = typeof p === "string" ? p : undefined;
    if (d.eventName === "UPDATE_STATE") {
      if (pb === undefined || pb === playback) return;
      playback = pb;
    }
    log.push(pb === undefined ? { t: Date.now(), event: d.eventName } : { t: Date.now(), event: d.eventName, playback: pb });
  });
}

/** Each page's raw Twitch SDK events, times relative to `zero` (ms). */
const sdkEvents = (clients: readonly Client[], zero: number): Promise<SdkEvent[][]> =>
  Promise.all(clients.map(async (c) => (await c.page.evaluate(() => window.__twitchSdkLog ?? [])).map((e) => ({ ...e, t: e.t - zero }))));

/** Two Chromium processes with their own profiles (the "2+ browsers" of the checklist), each in the lobby. */
async function twoBrowsers(prefix: string, opts: { twitchLog?: true } = {}): Promise<{ browsers: Browser[]; a: Client; b: Client }> {
  const browsers = [await chromium.launch({ headless: false }), await chromium.launch({ headless: false })];
  const [one, two] = browsers;
  if (one === undefined || two === undefined) throw new Error("no browsers");
  const context = async (br: Browser) => {
    const c = await watchCsp(await br.newContext());
    if (opts.twitchLog) await c.addInitScript(logTwitchSdk);
    return c;
  };
  const a = await enter(await context(one), `${prefix}-1`);
  const b = await enter(await context(two), `${prefix}-2`);
  return { browsers, a, b };
}

async function frames(a: Client, b: Client, provider: RealProvider, id: string): Promise<[Frame, Frame]> {
  return [await providerFrame(a.page, provider, id), await providerFrame(b.page, provider, id)];
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
      const steady = await mediaSpread(fa, fb, 16, 500, SPREAD_BUDGET_MS);

      await a.page.locator(site.playToggle).click();
      await a.page.waitForTimeout(2_500);
      const paused = await Promise.all([sampleMedia(fa), sampleMedia(fb)]);
      const pausedViews = await Promise.all([view(a.page), view(b.page)]);

      await a.page.locator(site.playToggle).click();
      await a.page.waitForTimeout(3_000);
      const afterPlay = await mediaSpread(fa, fb, 10, 250, SPREAD_BUDGET_MS);

      const target = 300;
      const seekAt = Date.now();
      await seekTo(a.page, target);
      await a.page.waitForTimeout(4_000);
      const seeked = await Promise.all([sampleMedia(fa), sampleMedia(fb)]);
      /** How far a player is behind the room clock (target + time since the seek), at that sample's own time. */
      const lag = (s: MediaSample | null): number | null => (s === null ? null : Math.round((target + (s.t - seekAt) / 1000 - s.currentTime) * 1000));
      const afterSeek = await mediaSpread(fa, fb, 10, 250, SPREAD_BUDGET_MS);
      // Buffering after a seek puts both behind the room clock for a moment; the sync loop must bring them back.
      await a.page.waitForTimeout(6_000);
      const later = await Promise.all([sampleMedia(fa), sampleMedia(fb)]);
      const lagMs = later.map(lag);
      await Promise.all([shot(a.page, `m2-${c.key}-1`), shot(b.page, `m2-${c.key}-2`)]);

      const pausedDiffMs = paused[0] && paused[1] ? Math.round((paused[0].currentTime - paused[1].currentTime) * 1000) : null;
      const result = {
        url: c.url,
        plate: await a.page.locator('[data-testid="provider-plate"]').textContent(),
        seekOnly: va.seekOnly,
        live: va.live,
        videoRates: (await Promise.all([sampleMedia(fa), sampleMedia(fb)])).map((s) => s?.playbackRate ?? null),
        adsBeforeContent: ads.map((x) => ({ samples: x.length, roomAlwaysPlaying: x.every((s) => s.roomPlaying !== false), catchingSeen: x.some((s) => s.catching === true) })),
        steady,
        paused: { bothPaused: paused.every((p) => p?.paused === true), pausedDiffMs, roomPlaying: pausedViews.map((v) => v.playing) },
        afterPlay,
        seek: { target, positions: seeked.map((s) => s?.currentTime ?? null), lagBehindRoomMs4s: seeked.map(lag), afterSeek, lagBehindRoomMs10s: lagMs },
        notices: await siteNotices(a.page),
      };
      record(`m2-${c.key}`, result);
      expect(result.live, "not live").toBe(false);
      expect(steady.samplesMs.length, "steady samples").toBeGreaterThan(5);
      expect(steady.heldMaxAbsMs).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
      expect(result.paused.bothPaused, "a pause from browser 1 pauses browser 2's real player").toBe(true);
      expect(Math.abs(pausedDiffMs ?? Infinity)).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
      expect(afterPlay.heldMaxAbsMs).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
      // Both really moved to the seek target (so <video>.currentTime is the media position, not an MSE timeline).
      for (const l of result.seek.lagBehindRoomMs4s) expect(Math.abs(l ?? Infinity), "near the seek target 4 s after it").toBeLessThan(5_000);
      for (const l of lagMs) expect(Math.abs(l ?? Infinity), "caught up with the room clock 10 s after the seek").toBeLessThan(1_000);
      expect(afterSeek.heldMaxAbsMs).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    } finally {
      await closeAll(...browsers);
    }
  });
}

test("M2-twitch-live · pause and play-from-live reach both browsers; no scrubber; ads as found", async ({ request }, testInfo) => {
  // OME-500: each page's raw SDK events, to confirm or refute a mid-roll slate (pause/play by itself) after a resume.
  const { browsers, a, b } = await twoBrowsers("real-live", { twitchLog: true });
  let currentChannel: string | null = null;
  let discovery: Awaited<ReturnType<typeof discoverPairedLive>> | null = null;
  let capturedFailure = false;
  try {
    // Manually launched contexts need explicit ownership of both viewers' traces.
    await Promise.all([a, b].map(async (c) => {
      await c.context.tracing.stop();
      await c.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    }));
    const live = await discoverPairedLive(REAL.twitchLive, {
      share: async (channel) => { currentChannel = channel; await shareUrl(request, twitchLiveUrl(channel)); },
      observe: async (channel) => Promise.all([liveViewer(a, channel), liveViewer(b, channel)]),
      now: Date.now,
      pause: () => a.page.waitForTimeout(500),
    });
    discovery = live;
    record("m2-twitch-live-discovery", live);
    await testInfo.attach("paired-live-discovery", { body: JSON.stringify(live, null, 2), contentType: "application/json" });
    const { channel } = live;
    if (channel === null) {
      record("m2-twitch-live", { notRun: "no candidate was eligible for both ungated viewers; set OMEGA_REAL_TWITCH_LIVE", tried: live.tried });
      test.skip(true, `no Twitch candidate is eligible for both ungated viewers (${live.tried.map((x) => `${x.channel}: ${x.outcome} (${x.viewers.map((v) => v.reason).join(" / ")})`).join(", ")}); set OMEGA_REAL_TWITCH_LIVE`);
      return;
    }
    const [fa, fb] = await frames(a, b, "twitch", channel);
    const ads = await Promise.all([waitMediaPlaying(a, fa), waitMediaPlaying(b, fb)]);
    await a.page.waitForTimeout(3_000);
    const va = await view(a.page);
    const chrome = {
      live: va.live,
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
      /** t = ms after the pause click; the play click is at playAt − pauseAt. */
      sdkEvents: { playAtMs: playAt - pauseAt, pages: await sdkEvents([a, b], pauseAt) },
    };
    record("m2-twitch-live", result);
    expect(chrome.live).toBe(true);
    expect(chrome.livePill, "live pill is visible").toBe(true);
    expect(result.finalPlaying, "both ungated players keep playing").toEqual([true, true]);
    expect(chrome.seekVisible, "no scrubber on live").toBe(false);
    expect(pauseArrival.every((x) => x !== null), "both real players paused").toBe(true);
    expect(playArrival.every((x) => x !== null), "both real players resumed").toBe(true);
    // The live spread budget is board question B1 (ADR 0014): recorded, only a sanity bound here.
    expect(result.pause.spreadMs ?? Infinity).toBeLessThan(2_000);
  } catch (error) {
    if (testInfo.expectedStatus === "skipped") throw error;
    capturedFailure = true;
    const tasks: Record<string, () => Promise<unknown>> = {};
    for (const [index, client] of [a, b].entries()) {
      const name = `viewer-${String(index + 1)}`;
      tasks[`${name}-snapshot`] = () => liveViewer(client, currentChannel);
      tasks[`${name}-dom`] = async () => {
        const snapshot = await liveViewer(client, currentChannel);
        const frame = client.page.frames().find((f) => f.url() === snapshot.frameUrl && !f.isDetached());
        const dom = { page: await client.page.content(), player: frame === undefined ? null : await frame.content() };
        const path = testInfo.outputPath(`${name}-dom.json`);
        writeFileSync(path, `${JSON.stringify(dom, null, 2)}\n`);
        await testInfo.attach(`${name}-dom`, { path, contentType: "application/json" });
        return path;
      };
      tasks[`${name}-screenshot`] = async () => {
        const path = testInfo.outputPath(`${name}.png`);
        await client.page.screenshot({ path });
        await testInfo.attach(`${name}-screenshot`, { path, contentType: "image/png" });
        return path;
      };
      tasks[`${name}-trace`] = async () => {
        const path = testInfo.outputPath(`${name}-trace.zip`);
        await client.context.tracing.stop({ path });
        await testInfo.attach(`${name}-trace`, { path, contentType: "application/zip" });
        return path;
      };
    }
    const evidence = { error: error instanceof Error ? error.message : String(error), channel: currentChannel, discovery, captures: await collectGateEvidence(tasks) };
    const path = testInfo.outputPath("paired-live-failure.json");
    const saved = await collectGateEvidence({ failureJson: async () => {
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
      await testInfo.attach("paired-live-failure", { path, contentType: "application/json" });
      return path;
    } });
    if (saved["failureJson"]?.error) console.warn("paired live failure evidence could not be saved", saved);
    throw error;
  } finally {
    if (!capturedFailure) {
      await Promise.allSettled([a, b].map((c) => c.context.tracing.stop()));
      await closeAll(...browsers);
    } else {
      await Promise.allSettled(browsers.map((browser) => browser.close()));
    }
  }
});

/** A snapshot from the current candidate only; a previous channel's detaching iframe cannot count. */
async function gateViewer(client: Client, channel: string | null) {
  const frame = client.page.frames().find((f) => {
    if (channel === null || f.isDetached() || !URL.canParse(f.url())) return false;
    const url = new URL(f.url());
    return url.host === "player.twitch.tv" && url.searchParams.get("channel") === channel;
  });
  const [gate, media, room] = await Promise.all([
    frame === undefined ? false : gateShown(frame),
    frame === undefined ? null : sampleMedia(frame),
    view(client.page).catch(() => null),
  ]);
  const reason = frame === undefined ? "no-frame" : gate ? "mature-gate" : media?.overlay ? `overlay: ${media.overlay}` : media?.ad ? "advertisement" : media !== null && !media.paused && media.currentTime > 0.5 ? "ungated-playing" : "no-gate; waiting for upstream player";
  return { viewer: client.nickname, gate, reason, frameUrl: frame?.url() ?? null, media, room };
}

/** Same candidate-bound snapshot as M3, including the room error used by M2 discovery. */
async function liveViewer(client: Client, channel: string | null) {
  const snapshot = await gateViewer(client, channel);
  return { ...snapshot, error: snapshot.room?.error ?? null };
}

test("M3-twitch-gate · a mature-gated live channel: both members see the Start Watching hint, press it, and stay in sync", async ({ request }, testInfo) => {
  const started = Date.now();
  const { browsers, a, b } = await twoBrowsers("real-gate", { twitchLog: true });
  // Leave time for both manual contexts' screenshots/traces before the runner closes them.
  const actionTimeoutMs = 10_000;
  for (const client of [a, b]) client.page.setDefaultTimeout(actionTimeoutMs);
  let currentChannel: string | null = null;
  let discovery: Awaited<ReturnType<typeof discoverPairedGate>> | null = null;
  let capturedFailure = false;
  const actions: { action: string; atMs: number; outcome: "started" | "completed" }[] = [];
  let checkActive: () => void = () => undefined;
  const action = async (name: string, perform: () => Promise<unknown>) => {
    checkActive();
    actions.push({ action: name, atMs: Date.now() - started, outcome: "started" });
    await perform();
    checkActive();
    actions.push({ action: name, atMs: Date.now() - started, outcome: "completed" });
  };
  try {
    const remainingMs = Math.max(1, testInfo.timeout - (Date.now() - started) - 30_000);
    await runGateWorkflow(async (assertActive) => {
      checkActive = assertActive;
      // Playwright may have auto-started tracing even for these manual contexts. Own explicit traces
      // so failures attach both viewers instead of relying on the runner's context selection.
      await Promise.all([a, b].map(async (c) => {
        await c.context.tracing.stop();
        await c.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      }));
      // Discovery runs in its own tab so the room pages stay in the room.
      const scout = await a.context.newPage();
      const candidates = REAL.twitchGated.length > 0 ? REAL.twitchGated : await liveInCategories(scout, REAL.twitchGatedCategories);
      await scout.close();
      discovery = await discoverPairedGate(candidates, {
        share: async (channel) => { checkActive(); currentChannel = channel; await shareUrl(request, twitchLiveUrl(channel)); },
        observe: async (channel) => { checkActive(); return Promise.all([gateViewer(a, channel), gateViewer(b, channel)]); },
        now: Date.now,
        pause: () => a.page.waitForTimeout(500),
      });
      checkActive();
      const { channel, tried } = discovery;
      record("m3-twitch-gate-discovery", discovery);
      await testInfo.attach("paired-gate-discovery", { body: JSON.stringify(discovery, null, 2), contentType: "application/json" });
      checkActive();
      if (channel === null) {
        const notRun = "no candidate showed the mature gate to both logged-out viewers; set OMEGA_REAL_TWITCH_GATED";
        record("m3-twitch-gate", { notRun, tried });
        test.skip(true, `${notRun} (${tried.map((x) => `${x.channel}: ${x.viewers.map((v) => v.reason).join(" / ")}`).join(", ")})`);
        return;
      }
      const [fa, fb] = await frames(a, b, "twitch", channel);
      const hints = await Promise.all([a, b].map(async (c) => ({ visible: await c.page.locator(site.tvHint).isVisible(), text: (await c.page.locator(site.tvHint).textContent())?.trim() ?? null })));
      const gatedViews = await Promise.all([view(a.page), view(b.page)]);
      await Promise.all([shot(a.page, "m3-twitch-gate-gated-1"), shot(b.page, "m3-twitch-gate-gated-2")]);

      // Each member has their own gate. Browser 1 presses first: browser 2 stays gated and nobody's room state changes.
      await action("viewer-1-start-watching", () => fa.locator(TWITCH_START_WATCHING).click({ timeout: actionTimeoutMs }));
      await expect.poll(() => gateShown(fa), { timeout: 10_000, message: "browser 1's gate goes away" }).toBe(false);
      await a.page.waitForTimeout(3_000);
      const halfway = { bStillGated: await gateShown(fb), views: (await Promise.all([view(a.page), view(b.page)])).map((v) => ({ playing: v.playing, error: v.error })) };
      await action("viewer-2-start-watching", () => fb.locator(TWITCH_START_WATCHING).click({ timeout: actionTimeoutMs }));
      await expect.poll(() => gateShown(fb), { timeout: 10_000, message: "browser 2's gate goes away" }).toBe(false);
      const contentTimeoutMs = Math.min(120_000, Math.max(1, 240_000 - (Date.now() - started)));
      const ads = await Promise.all([waitMediaPlaying(a, fa, contentTimeoutMs), waitMediaPlaying(b, fb, contentTimeoutMs)]);
      await a.page.waitForTimeout(3_000);

      const pauseAt = Date.now();
      await action("shared-pause", () => a.page.locator(site.playToggle).click({ timeout: actionTimeoutMs }));
      const pauseArrival = await arrival([fa, fb], true, pauseAt);
      await a.page.waitForTimeout(2_000);
      const playAt = Date.now();
      await action("shared-play", () => a.page.locator(site.playToggle).click({ timeout: actionTimeoutMs }));
      const playArrival = await arrival([fa, fb], false, playAt, 10_000);
      await a.page.waitForTimeout(3_000);
      const final = await Promise.all([sampleMedia(fa), sampleMedia(fb)]);
      const finalViews = await Promise.all([view(a.page), view(b.page)]);
      await Promise.all([shot(a.page, "m3-twitch-gate-after-1"), shot(b.page, "m3-twitch-gate-after-2")]);
      const spread = (xs: (number | null)[]): number | null => (xs.every((x) => x !== null) ? Math.max(...(xs)) - Math.min(...(xs)) : null);
      const result = {
        channel,
        tried,
        actions,
        sdkEvents: await sdkEvents([a, b], started),
        hints,
        gatedViews: gatedViews.map((v) => ({ live: v.live, playing: v.playing, error: v.error })),
        halfway,
        adsAfterGate: ads.map((x) => x.length),
        pause: { arrivalMs: pauseArrival, spreadMs: spread(pauseArrival) },
        play: { arrivalMs: playArrival, spreadMs: spread(playArrival) },
        finalPlaying: final.map((s) => (s === null ? null : !s.paused)),
        finalViews: finalViews.map((v) => ({ playing: v.playing, error: v.error })),
        notices: await Promise.all([siteNotices(a.page), siteNotices(b.page)]),
      };
      checkActive();
      record("m3-twitch-gate", result);
      for (const h of hints) {
        expect(h.visible, "the Start Watching hint shows for every member").toBe(true);
        expect(h.text).toBe("If the Twitch player asks, press Start Watching in it.");
      }
      for (const v of result.gatedViews) expect(v.error, "the gate isn't a room error").toBeNull();
      expect(halfway.bStillGated, "one member's Start Watching doesn't lift another's gate").toBe(true);
      for (const v of halfway.views) expect(v, "one member pressing Start Watching leaves the room playing").toEqual({ playing: true, error: null });
      expect(pauseArrival.every((x) => x !== null), "both real players paused after the gate").toBe(true);
      expect(playArrival.every((x) => x !== null), "both real players resumed after the gate").toBe(true);
      expect(result.pause.spreadMs ?? Infinity).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
      // Real play-from-live is Twitch's live-edge reload, not our relay: recorded, only a sanity bound (ADR 0048).
      expect(result.play.spreadMs ?? Infinity).toBeLessThan(LIVE_PLAY_SANITY_MS);
      expect(result.finalPlaying).toEqual([true, true]);
      for (const v of result.finalViews) expect(v).toEqual({ playing: true, error: null });
    }, remainingMs);
  } catch (error) {
    if (testInfo.expectedStatus === "skipped") throw error;
    // These contexts are launched manually, so the runner's default failure trace does not cover them.
    // Capture before closing either browser; one failed capture must not discard the other viewer's evidence.
    capturedFailure = true;
    const tasks: Record<string, () => Promise<unknown>> = {};
    for (const [index, client] of [a, b].entries()) {
      const name = `viewer-${String(index + 1)}`;
      tasks[`${name}-snapshot`] = () => gateViewer(client, currentChannel);
      tasks[`${name}-sdk-events`] = () => sdkEvents([client], started);
      tasks[`${name}-screenshot`] = async () => {
        const path = testInfo.outputPath(`${name}.png`);
        await client.page.screenshot({ path, timeout: 5_000 });
        await testInfo.attach(`${name}-screenshot`, { path, contentType: "image/png" });
        return path;
      };
      tasks[`${name}-trace`] = async () => {
        const path = testInfo.outputPath(`${name}-trace.zip`);
        await client.context.tracing.stop({ path });
        await testInfo.attach(`${name}-trace`, { path, contentType: "application/zip" });
        return path;
      };
    }
    const evidence = { error: error instanceof Error ? error.message : String(error), channel: currentChannel, discovery, actions, captures: await collectGateEvidence(tasks) };
    const path = testInfo.outputPath("paired-gate-failure.json");
    const saved = await collectGateEvidence({ failureJson: async () => {
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
      await testInfo.attach("paired-gate-failure", { path, contentType: "application/json" });
      return path;
    } });
    if (saved["failureJson"]?.error) console.warn("paired gate failure evidence could not be saved", saved);
    throw error;
  } finally {
    if (!capturedFailure) {
      await Promise.allSettled([a, b].map((c) => c.context.tracing.stop()));
      await closeAll(...browsers);
    } else {
      await Promise.allSettled(browsers.map((browser) => browser.close()));
    }
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
        playing: v.playing,
        canControl: v.canControl,
        error: v.error,
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
