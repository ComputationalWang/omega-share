// Opt-in real-YouTube checks for the M1b sign-off (OME-91): `bun run e2e:real`. Real network, headed Chromium, never in CI.
// The checklist and how to read the results: docs/qa/m1b-real-youtube.md. Each test writes its evidence to
// e2e/real/results/<item>.json (+ .png). YouTube changes under us, so the numbers matter more than a green tick.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import type { PlaybackView } from "../../apps/web/src/controls/playback";
import { BURST_FAST, BURST_SLOW, initialRateMode, nextRateMode } from "../../apps/web/src/sync";
import { site } from "../support/selectors";
import {
  AD_IDS, BASELINE_ID, cdpTargets, closeAll, cspViolations, enter, EVIDENCE_DIR, rawTab, record, ROOM_URL, sampleVideo, share, shot, slope, spreadOver,
  waitVideoPlaying, watchPage, ytFrame,
} from "./real";

/** Embedding disabled by the owner (`playableInEmbed: false`, oEmbed 401). Override with OMEGA_REAL_NOEMBED_ID. */
const NOEMBED_ID = process.env["OMEGA_REAL_NOEMBED_ID"] ?? "s5qx1X78ujE";
/** Age-restricted ("Sign in to confirm your age"). Override with OMEGA_REAL_AGE_ID. */
const AGE_ID = process.env["OMEGA_REAL_AGE_ID"] ?? "fVs0suPHAX8";

const view = (page: Page): Promise<PlaybackView | null> => page.evaluate(() => window.__omega?.room?.playback() ?? null);

// Independent tests, one worker (they share the lobby): one failing item doesn't hide the others.
test.setTimeout(180_000);

test("8 · path-scoped CSP loads the current www-widgetapi.js; 4 · nocookie host plays with the API attached", async ({ browser, request }) => {
  const ctx = await browser.newContext();
  const probe = await ctx.newPage();
  const w = await watchPage(probe);
  await probe.goto(ROOM_URL);
  await probe.locator(site.nicknameInput).fill("real-csp");
  await probe.locator(site.joinButton).click();
  await probe.locator(site.room).waitFor();
  try {
    await share(request, BASELINE_ID);
    const frame = await ytFrame(probe, BASELINE_ID);
    await expect.poll(async () => (await view(probe))?.hasVideo ?? false, { timeout: 20_000, message: "adapter attached (onReady)" }).toBe(true);
    await waitVideoPlaying(frame);
    const src = await probe.locator(site.sharedVideo).getAttribute("src");
    const syncNoticeHidden = await probe.locator('[data-testid="sync-notice"]').isHidden();

    // The API really drives the nocookie player: our transport pauses and resumes the real <video>.
    await probe.locator(site.playToggle).click();
    await expect.poll(async () => (await sampleVideo(frame))?.paused, { timeout: 5_000, message: "paused by our control" }).toBe(true);
    await probe.locator(site.playToggle).click();
    await expect.poll(async () => (await sampleVideo(frame))?.paused, { timeout: 5_000, message: "resumed by our control" }).toBe(false);

    const csp = await cspViolations(probe);
    const widget = w.widget;
    await shot(probe, "04-nocookie");
    record("08-csp", { widget, cspViolations: csp, syncNoticeHidden });
    record("04-nocookie", { src, frameUrl: frame.url(), hasVideo: true, pauseResume: "ok" });
    expect(src ?? "").toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\//);
    expect(widget.length, "widget script requested").toBeGreaterThan(0);
    expect(widget.every((x) => x.status === 200)).toBe(true);
    expect(csp, "no CSP violations in the site's document").toEqual([]);
    expect(syncNoticeHidden).toBe(true);
  } finally {
    await ctx.close();
  }
});

test("5 · effective rate at 1.05: getCurrentTime slope over 30 s + video.playbackRate; which rung is active", async ({ browser, request }) => {
  // (a) Raw player, outside the sync loop: attach the API to a nocookie iframe on a localhost page, like tvFrame() does.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${ROOM_URL.replace(/\/r\/.*$/, "")}/`);
  const setup = await page.evaluate(async (id) => {
    document.body.replaceChildren();
    const f = document.createElement("iframe");
    f.width = "640";
    f.height = "360";
    f.allow = "autoplay; encrypted-media";
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.src = `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&origin=${encodeURIComponent(location.origin)}&controls=0&playsinline=1&autoplay=1&mute=1`;
    document.body.append(f);
    interface P { setPlaybackRate(r: number): void; getPlaybackRate(): number; getCurrentTime(): number; getAvailablePlaybackRates(): number[] }
    const w = window as unknown as { onYouTubeIframeAPIReady?: () => void; YT?: { Player: new (el: HTMLIFrameElement, o: object) => P }; __p?: P };
    await new Promise<void>((resolve) => {
      w.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.append(s);
    });
    const YT = w.YT;
    if (YT === undefined) throw new Error("no YT");
    await new Promise<void>((resolve) => {
      w.__p = new YT.Player(f, { events: { onStateChange: (e: { data: number }) => { if (e.data === 1) resolve(); } } });
    });
    return w.__p?.getAvailablePlaybackRates() ?? [];
  }, BASELINE_ID);
  const frame = await ytFrame(page, BASELINE_ID);
  await waitVideoPlaying(frame);

  const measure = async (rate: number, seconds: number) => {
    const reported = await page.evaluate((r) => {
      const p = (window as unknown as { __p: { setPlaybackRate(r: number): void; getPlaybackRate(): number } }).__p;
      p.setPlaybackRate(r);
      return new Promise<number>((res) => setTimeout(() => { res(p.getPlaybackRate()); }, 1000));
    }, rate);
    const pts: [number, number][] = [];
    const videoRates = new Set<number>();
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const [t, v] = await Promise.all([
        page.evaluate(() => [performance.now() / 1000, (window as unknown as { __p: { getCurrentTime(): number } }).__p.getCurrentTime()] as const),
        sampleVideo(frame),
      ]);
      pts.push([t[0], t[1]]);
      if (v !== null) videoRates.add(v.playbackRate);
      await page.waitForTimeout(250);
    }
    return { requested: rate, reported, slope: Number(slope(pts).toFixed(4)), videoPlaybackRate: [...videoRates], samples: pts.length };
  };
  const at1 = await measure(1, 10);
  const at105 = await measure(1.05, 30);
  const rungAfterCheck = nextRateMode(initialRateMode(setup), 1.05, at105.slope, setup);
  // The sync loop's own check, replayed: set a nudge, then slope = Δ getCurrentTime / Δ wall over RATE_CHECK_MS (2 s)
  // from the moment of the set call, exactly as createSyncLoop does. Rates are the ones the loop sends since OME-109
  // (whole 0.05 steps, ADR 0013); off-grid rates are only probed for what the <video> really plays (YouTube floors them).
  const replayWindow = (requested: number) =>
    page.evaluate(async (r) => {
      const p = (window as unknown as { __p: { setPlaybackRate(r: number): void; getCurrentTime(): number } }).__p;
      p.setPlaybackRate(1);
      await new Promise((res) => setTimeout(res, 1500));
      const t0 = performance.now();
      const c0 = p.getCurrentTime();
      p.setPlaybackRate(r);
      await new Promise((res) => setTimeout(res, 2000));
      return Number(((p.getCurrentTime() - c0) / ((performance.now() - t0) / 1000)).toFixed(4));
    }, requested);
  const replay: { requested: number; slope: number; videoPlaybackRate: number | null; rung: string }[] = [];
  for (const requested of [0.95, 1.05, 0.9, 1.1, 0.95, 1.05, 0.9, 1.1]) {
    const s = await replayWindow(requested);
    replay.push({ requested, slope: s, videoPlaybackRate: (await sampleVideo(frame))?.playbackRate ?? null, rung: nextRateMode("fine", requested, s, setup) });
  }
  const offGrid: { requested: number; videoPlaybackRate: number | null }[] = [];
  for (const requested of [1.02, 1.03, 0.98, 0.97]) {
    await replayWindow(requested);
    offGrid.push({ requested, videoPlaybackRate: (await sampleVideo(frame))?.playbackRate ?? null });
  }
  await ctx.close();
  record("05-rate-raw", { availableRates: setup, at1, at105, rungAfterCheck, loopCheckReplay: replay, falseDowngrades: replay.filter((x) => x.rung !== "fine").length, offGrid });

  // (b) In the room: push one client ~600 ms ahead (inside the 1 s seek threshold) and watch what the sync loop does.
  const a = await enter(await browser.newContext(), "real-rate-a");
  const b = await enter(await browser.newContext(), "real-rate-b");
  try {
    await share(request, BASELINE_ID);
    const fa = await ytFrame(a.page, BASELINE_ID);
    const fb = await ytFrame(b.page, BASELINE_ID);
    await Promise.all([waitVideoPlaying(fa), waitVideoPlaying(fb)]);
    // The rung the loop settles on by itself after joining (a fine nudge is ≤ 10 %; burst is 0.75/1.25).
    const settle: { t: number; a: number; b: number }[] = [];
    const s0 = Date.now();
    while (Date.now() - s0 < 12_000) {
      const [sa, sb] = await Promise.all([sampleVideo(fa), sampleVideo(fb)]);
      settle.push({ t: Date.now() - s0, a: sa?.playbackRate ?? -1, b: sb?.playbackRate ?? -1 });
      await a.page.waitForTimeout(200);
    }
    await fb.evaluate(() => {
      const v = document.querySelector("video");
      if (v !== null) v.currentTime += 0.6;
    });
    const rates: { t: number; rate: number }[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      const s = await sampleVideo(fb);
      if (s !== null) rates.push({ t: Date.now() - t0, rate: s.playbackRate });
      await b.page.waitForTimeout(250);
    }
    const seen = [...new Set(rates.map((r) => r.rate))];
    const inRoomRung = seen.some((r) => r !== 1 && r !== BURST_SLOW && r !== BURST_FAST)
      ? "fine"
      : seen.some((r) => r === BURST_SLOW || r === BURST_FAST) ? "burst" : "seek-only (or corrected by seek)";
    const after = await spreadOver(fa, fb, 8, 250);
    record("05-rate", { availableRates: setup, at1, at105, rungAfterCheck, loopCheckReplay: replay, offGrid, inRoom: { afterJoinRates: [...new Set(settle.flatMap((x) => [x.a, x.b]))], afterJoin: settle.filter((x) => x.a !== 1 || x.b !== 1), videoRatesSeen: seen, inRoomRung, spreadAfter: after, trace: rates } });
    expect(at105.reported).toBeCloseTo(1.05, 2);
    expect(at105.videoPlaybackRate, "the media element really plays at 1.05").toEqual([1.05]);
    expect(at105.slope).toBeCloseTo(1.05, 2);
    // Fine rates really apply, so the ladder should stay on its first rung.
    expect(replay.filter((x) => x.rung !== "fine"), "the 2 s check never downgrades a working fine rate").toEqual([]);
    expect(replay.every((x) => x.videoPlaybackRate === x.requested), "grid rates play as sent").toBe(true);
    expect(inRoomRung, "the room's sync loop is on the fine rung").toBe("fine");
    expect(after.maxAbsMs, "corrected back inside the dead band-ish").toBeLessThan(500);
  } finally {
    await closeAll(a.context, b.context);
  }
});

test("3 · sound after Enter room (Playwright, real click)", async ({ browser, request }) => {
  await share(request, BASELINE_ID);
  const a = await enter(await browser.newContext(), "real-sound");
  try {
    const fa = await ytFrame(a.page, BASELINE_ID);
    await waitVideoPlaying(fa);
    const sound = await sampleVideo(fa);
    const soundView = await view(a.page);
    record("03-sound", { video: sound, view: soundView });
    expect(sound?.muted, "real click → sound").toBe(false);
    expect(sound?.volume).toBeGreaterThan(0);
    expect(soundView?.needsUnmute).toBe(false);
  } finally {
    await a.context.close();
  }
});

test("3 · muted fallback + Unmute (raw-CDP Chromium with no user activation)", async ({ request }) => {
  await share(request, BASELINE_ID);
  const port = 9339;
  const profile = mkdtempSync(join(tmpdir(), "omega-real-"));
  const proc = spawn(chromium.executablePath(), [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${String(port)}`, "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=document-user-activation-required", "--window-size=1280,1000",
    // As Playwright does: a window the compositor considers hidden gets no animation frames, and the controls render on rAF.
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "about:blank",
  ], { stdio: "ignore" });
  try {
    await expect.poll(async () => (await cdpTargets(port).catch(() => [])).some((t) => t.type === "page"), { timeout: 15_000 }).toBe(true);
    const pageTarget = (await cdpTargets(port)).find((t) => t.type === "page");
    if (pageTarget === undefined) throw new Error("no page target");
    const tab = await rawTab(pageTarget.webSocketDebuggerUrl);
    await tab.eval(`location.href = ${JSON.stringify(ROOM_URL)}`);
    // The button is static HTML; wait for main.ts (dev builds set window.__omega) before clicking it.
    await expect.poll(() => tab.eval<boolean>("location.pathname.startsWith('/r/') && window.__omega !== undefined"), { timeout: 15_000 }).toBe(true);
    await tab.eval(`(() => { const i = document.querySelector('${site.nicknameInput}'); i.value = "real-muted";
      i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector('${site.joinButton}').click(); })()`);
    const playback = () => tab.eval<PlaybackView | null>("window.__omega?.room?.playback() ?? null");
    await expect.poll(async () => (await playback())?.needsUnmute ?? false, { timeout: 20_000, message: "onAutoplayBlocked → needsUnmute" }).toBe(true);
    const frameVideo = async () => {
      const f = (await cdpTargets(port)).find((t) => t.type === "iframe" && t.url.includes(`/embed/${BASELINE_ID}`));
      if (f === undefined) return null;
      const ft = await rawTab(f.webSocketDebuggerUrl);
      const v = await ft.eval<{ muted: boolean; paused: boolean; currentTime: number; volume: number } | null>(
        `(() => { const v = document.querySelector("video"); return v && { muted: v.muted, paused: v.paused, currentTime: v.currentTime, volume: v.volume }; })()`);
      ft.close();
      return v;
    };
    const blocked = { hasBeenActive: await tab.eval<boolean>("navigator.userActivation.hasBeenActive"), view: await playback(), video: await frameVideo() };
    await expect.poll(() => tab.eval<boolean>(`!document.querySelector('${site.unmuteButton}').hidden`), { timeout: 5_000, message: "Unmute shown" }).toBe(true);
    await tab.eval(`document.querySelector('${site.unmuteButton}').scrollIntoView({ block: "center" })`);
    await tab.screenshot(join(EVIDENCE_DIR, "03-muted-fallback.png"));
    await tab.click(site.unmuteButton);
    await expect.poll(async () => (await playback())?.needsUnmute, { timeout: 5_000, message: "Unmute cleared needsUnmute" }).toBe(false);
    await expect.poll(async () => (await frameVideo())?.muted, { timeout: 5_000, message: "the real <video> unmuted" }).toBe(false);
    const after = { view: await playback(), video: await frameVideo(), unmuteHidden: await tab.eval<boolean>(`document.querySelector('${site.unmuteButton}').hidden`) };
    await tab.screenshot(join(EVIDENCE_DIR, "03-after-unmute.png"));
    tab.close();
    record("03-muted-fallback", { blocked, after });
    expect(blocked.hasBeenActive).toBe(false);
    expect(blocked.video?.muted, "fallback plays muted").toBe(true);
    expect(blocked.video?.paused, "fallback still plays").toBe(false);
    expect(after.unmuteHidden).toBe(true);
  } finally {
    proc.kill();
  }
});

test("2 · embedding-disabled and age-restricted videos show a clear notice", async ({ browser, request }) => {
  const a = await enter(await browser.newContext(), "real-errors");
  interface Case { id: string; played: boolean; inPlayer: string; siteNotices: string[]; view: PlaybackView | null }
  const results: Record<string, Case> = {};
  try {
    for (const [name, id] of [["noEmbed", NOEMBED_ID], ["ageRestricted", AGE_ID]] as const) {
      await share(request, id);
      const frame = await ytFrame(a.page, id);
      await a.page.waitForTimeout(6_000);
      const inPlayer = await frame.evaluate(() => {
        const e = document.querySelector(".ytp-error, .ytp-error-content, .ytp-embed-error");
        return e === null ? "" : e.textContent.replace(/\s+/g, " ").trim();
      });
      const video = await sampleVideo(frame);
      const notices = await a.page.locator('[data-testid="room-notice"], [data-testid="sync-notice"], [data-testid="system-line"]').evaluateAll((els) =>
        els.filter((e) => e instanceof HTMLElement && !e.hidden && e.offsetParent !== null).map((e) => e.textContent.trim()),
      );
      await shot(a.page, `02-${name}`);
      results[name] = { id, played: video !== null && !video.paused && video.currentTime > 1, inPlayer, siteNotices: notices, view: await view(a.page) };
    }
    record("02-errors", results);
    for (const [name, x] of Object.entries(results)) {
      // A video YouTube lets through (no age gate for this viewer) needs no notice. One it refuses needs ours, not
      // only YouTube's in-player text: the room's transport must stop claiming it plays (research §1.1 onError).
      if (x.played) continue;
      expect(x.siteNotices.some((t) => /can.t|cannot|unavailable|not allowed|embed|age/i.test(t)), `${name}: the site says why it can't play`).toBe(true);
      expect(x.view?.playing, `${name}: the transport stops claiming the room plays here`).toBe(false);
      expect(x.view?.canControl, `${name}: the transport is frozen`).toBe(false);
    }
  } finally {
    await a.context.close();
  }
});

test("6 · buffering under Slow 4G doesn't pause the room; the slow client catches up", async ({ browser, request }) => {
  const a = await enter(await browser.newContext(), "real-fast");
  const b = await enter(await browser.newContext(), "real-slow4g");
  try {
    await share(request, BASELINE_ID);
    const fa = await ytFrame(a.page, BASELINE_ID);
    const fb = await ytFrame(b.page, BASELINE_ID);
    await Promise.all([waitVideoPlaying(fa), waitVideoPlaying(fb)]);
    // DevTools "Slow 4G": 150 ms RTT × DevTools' 3.75 latency factor, 1.6 Mbps down × 0.9, 750 kbps up × 0.9. The player
    // is an out-of-process iframe, so throttle its target too.
    const conditions = { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8, uploadThroughput: (750 * 1024 * 0.9) / 8 };
    const sessions = [await b.context.newCDPSession(b.page), await b.context.newCDPSession(fb)];
    for (const s of sessions) {
      await s.send("Network.enable");
      await s.send("Network.emulateNetworkConditions", conditions);
    }
    // Seek to force a fresh fetch at the throttled rate.
    await a.page.locator(site.seek).evaluate((el) => {
      if (!(el instanceof HTMLInputElement)) return;
      el.value = String(Math.min(Number(el.max) || 300, 300));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const trace: { t: number; roomPlaying: boolean | null; slowCatching: boolean | null; slowPaused: boolean | null }[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      const [va, vb, sb] = await Promise.all([view(a.page), view(b.page), sampleVideo(fb)]);
      trace.push({ t: Date.now() - t0, roomPlaying: va?.playing ?? null, slowCatching: vb?.catching ?? null, slowPaused: sb?.paused ?? null });
      await a.page.waitForTimeout(500);
    }
    const throttled = await spreadOver(fa, fb, 8, 250);
    for (const s of sessions) await s.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await b.page.waitForTimeout(8_000);
    const recovered = await spreadOver(fa, fb, 8, 250);
    await shot(b.page, "06-slow4g");
    const caught = trace.filter((x) => x.slowCatching === true).length;
    record("06-slow4g", { conditions, roomAlwaysPlaying: trace.every((x) => x.roomPlaying === true), catchingSamples: caught, throttled, recovered, trace });
    expect(trace.every((x) => x.roomPlaying === true), "room never paused").toBe(true);
    expect(recovered.maxAbsMs).toBeLessThan(500);
  } finally {
    await closeAll(a.context, b.context);
  }
});

test("7 · two separate browsers (own profiles): spread", async ({ request }) => {
  const one: Browser = await chromium.launch({ headless: false });
  const two: Browser = await chromium.launch({ headless: false });
  try {
    const a = await enter(await one.newContext(), "real-browser-1");
    const b = await enter(await two.newContext(), "real-browser-2");
    await share(request, BASELINE_ID);
    const fa = await ytFrame(a.page, BASELINE_ID);
    const fb = await ytFrame(b.page, BASELINE_ID);
    await Promise.all([waitVideoPlaying(fa), waitVideoPlaying(fb)]);
    await a.page.waitForTimeout(3_000);
    const steady = await spreadOver(fa, fb, 20, 500);
    // A pause/play from browser 1, then measure again.
    await a.page.locator(site.playToggle).click();
    await b.page.waitForTimeout(2_000);
    const paused = await Promise.all([sampleVideo(fa), sampleVideo(fb)]);
    await a.page.locator(site.playToggle).click();
    await b.page.waitForTimeout(2_000);
    const afterPlay = await spreadOver(fa, fb, 10, 250);
    await Promise.all([shot(a.page, "07-browser-1"), shot(b.page, "07-browser-2")]);
    const pausedDiffMs = paused[0] !== null && paused[1] !== null ? Math.round((paused[0].currentTime - paused[1].currentTime) * 1000) : null;
    record("07-two-browsers", { steady, pausedDiffMs, bothPaused: paused.every((p) => p?.paused === true), afterPlay });
    expect(steady.maxAbsMs).toBeLessThanOrEqual(500);
    expect(afterPlay.maxAbsMs).toBeLessThanOrEqual(500);
  } finally {
    await closeAll(one, two);
  }
});

test("1 · pre-roll ad on a monetized video: the room doesn't pause; the client catches up", async ({ browser, request }) => {
  const a = await enter(await browser.newContext(), "real-ad-a");
  const b = await enter(await browser.newContext(), "real-ad-b");
  const attempts: unknown[] = [];
  try {
    for (const id of AD_IDS) {
      await share(request, id);
      const fa = await ytFrame(a.page, id);
      const fb = await ytFrame(b.page, id);
      const trace: { t: number; adA: boolean; adB: boolean; roomPlaying: boolean | null; catchingA: boolean | null; catchingB: boolean | null }[] = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 45_000) {
        const [sa, sb, va, vb] = await Promise.all([sampleVideo(fa), sampleVideo(fb), view(a.page), view(b.page)]);
        trace.push({ t: Date.now() - t0, adA: sa?.ad ?? false, adB: sb?.ad ?? false, roomPlaying: va?.playing ?? null, catchingA: va?.catching ?? null, catchingB: vb?.catching ?? null });
        if (trace.length === 8 && (sa?.ad === true || sb?.ad === true)) await shot(sa?.ad === true ? a.page : b.page, `01-ad-${id}`);
        const anyAd = trace.some((x) => x.adA || x.adB);
        if (!anyAd && Date.now() - t0 > 15_000) break;
        if (anyAd && !(sa?.ad ?? false) && !(sb?.ad ?? false) && Date.now() - t0 > 10_000) break;
        await a.page.waitForTimeout(500);
      }
      const sawAd = trace.some((x) => x.adA || x.adB);
      const after = sawAd ? (await a.page.waitForTimeout(6_000), await spreadOver(fa, fb, 8, 250)) : null;
      attempts.push({ id, sawAd, roomAlwaysPlaying: trace.every((x) => x.roomPlaying !== false), after, trace: trace.filter((x) => x.adA || x.adB) });
      if (sawAd) break;
    }
    record("01-ads", attempts);
    const hit = attempts.find((x) => (x as { sawAd: boolean }).sawAd) as { roomAlwaysPlaying: boolean; after: { maxAbsMs: number } } | undefined;
    test.skip(hit === undefined, "no ad served on any candidate; see 01-ads.json, rerun or check by hand");
    if (hit === undefined) return;
    expect(hit.roomAlwaysPlaying).toBe(true);
    expect(hit.after.maxAbsMs).toBeLessThan(1000);
  } finally {
    await closeAll(a.context, b.context);
  }
});
