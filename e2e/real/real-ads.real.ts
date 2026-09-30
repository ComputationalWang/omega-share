// Part A of the M3 real-world checklist (OME-194, docs/qa/m3-real-world.md): a deliberate attempt at a real pre-roll.
// Two fresh, logged-out Chromium processes that Playwright doesn't drive (it hands every page a user activation, see
// rawTab in real.ts) sit in the lobby. The spec shares monetised YouTube videos and live Twitch channels one by one and
// watches both real players for an ad. If one is served, it records what the other member saw (the catching-up tag,
// OME-101), whether the room stayed playing, and how long the member took to get back within the sync budget.
// If none is served, every attempt is recorded, and the fake-SDK ad cases stay the regression guard.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { expect, test } from "../support/csp";
import { site } from "../support/selectors";
import { REAL, twitchLiveUrl } from "./providers";
import { cdpTargets, embedUrl, EVIDENCE_DIR, rawTab, record, requireVirtualDisplay, ROOM_URL, shareUrl } from "./real";
import type { RawTab } from "./real";

test.beforeAll(requireVirtualDisplay);
test.describe.configure({ mode: "serial" });
test.setTimeout(30 * 60_000);

const list = (v: string): string[] => v.split(",").map((x) => x.trim()).filter((x) => x !== "");
/** Long, monetised uploads from large channels (music labels, late night, creators). Override with OMEGA_REAL_AD_YT. */
const YT = list(process.env["OMEGA_REAL_AD_YT"] ?? "dQw4w9WgXcQ,kJQP7kiw5Fk,JGwWNGJdvx8,OPf0YbXqDm0,0e3GPea1Tyg,2Vv-BfVoq4g,RgKAFK5djSk,YQHsXMglC9A");
/** Partnered channels, usually live, that run pre-rolls for logged-out viewers. The first 3 live ones count. */
const TWITCH = list(process.env["OMEGA_REAL_AD_TWITCH"] ?? [...REAL.twitchLive, "shroud", "summit1g", "tarik", "jynxzi", "hasanabi", "zackrawrr"].join(","));
const TWITCH_WANTED = 3;
/** How long each attempt watches for an ad before calling it ad-free (a pre-roll starts within a few seconds). */
const WATCH_MS = 30_000;
/** Longest ad break we wait out. */
const AD_MAX_MS = 150_000;
/** Budget for the spread after the ad (docs/perf-budgets.md, Sync row). */
const SPREAD_MS = 500;
/** Chrome for Testing by default; OMEGA_REAL_AD_BROWSER=/usr/bin/chromium tries a distro Chromium build instead. */
const BROWSER = process.env["OMEGA_REAL_AD_BROWSER"] ?? chromium.executablePath();
/** Evidence-name suffix, so a second run (another browser) doesn't overwrite the first. */
const TAG = process.env["OMEGA_REAL_AD_TAG"] ?? "";
/** OMEGA_REAL_AD_WARM=1: both profiles watch a youtube.com page first (its cookies, as a real viewer has), then the room. */
const WARM = process.env["OMEGA_REAL_AD_WARM"] === "1";

interface Raw {
  readonly name: string;
  readonly port: number;
  readonly proc: ChildProcess;
  readonly tab: RawTab;
}

/** A Chromium of its own: fresh profile, logged out, no extensions, default autoplay policy, driven over raw CDP only. */
async function launch(name: string, port: number): Promise<Raw> {
  const profile = mkdtempSync(join(tmpdir(), `omega-real-ads-${name}-`));
  const proc = spawn(BROWSER, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${String(port)}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,1000",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "about:blank",
  ], { stdio: "ignore" });
  await expect.poll(async () => (await cdpTargets(port).catch(() => [])).some((t) => t.type === "page"), { timeout: 15_000 }).toBe(true);
  const target = (await cdpTargets(port)).find((t) => t.type === "page");
  if (target === undefined) throw new Error(`${name}: no page target`);
  return { name, port, proc, tab: await rawTab(target.webSocketDebuggerUrl) };
}

/** Joins the lobby as a user would: types a name and clicks *Enter* with a trusted mouse click (a real activation). */
async function enterLobby(r: Raw): Promise<void> {
  await r.tab.eval(`location.href = ${JSON.stringify(ROOM_URL)}`);
  await expect.poll(() => r.tab.eval<boolean>("location.pathname.startsWith('/r/') && window.__omega !== undefined"), { timeout: 15_000 }).toBe(true);
  await r.tab.eval(`(() => { const i = document.querySelector('${site.nicknameInput}'); i.value = ${JSON.stringify(r.name)};
    i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await r.tab.click(site.joinButton);
  await expect.poll(() => r.tab.eval<boolean>(`!!document.querySelector('${site.room}') && !document.querySelector('${site.room}').hidden`), { timeout: 15_000 }).toBe(true);
}

interface PageState {
  readonly playing: boolean | null;
  readonly selfCatching: boolean | null;
  /** Other members' tags that show the catching-up hourglass. */
  readonly catchingTags: string[];
}

const pageState = (r: Raw): Promise<PageState> =>
  r.tab.eval<PageState>(`(() => { const v = window.__omega?.room?.playback() ?? null;
    return { playing: v?.playing ?? null, selfCatching: v?.catching ?? null,
      catchingTags: [...document.querySelectorAll('${site.nicknameTag}.catching')].map((e) => e.textContent.trim()) }; })()`);

interface PlayerState {
  readonly t: number;
  readonly currentTime: number;
  readonly paused: boolean;
  readonly ad: boolean;
  /** Ad badge / countdown text, or the overlay covering the player (errors, offline, consent). */
  readonly text: string;
}

/** Runs in the provider's iframe: its <video>, whether an ad shows, and any visible ad or overlay text. */
const PLAYER_PROBE = `(() => {
  const shown = (e) => e instanceof HTMLElement && e.offsetParent !== null;
  const yt = document.querySelector(".html5-video-player");
  const adEls = [...document.querySelectorAll('.ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining, [data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], [class*="video-ad"]')].filter(shown);
  const ad = (yt?.classList.contains("ad-showing") ?? false) || adEls.length > 0;
  const over = [...document.querySelectorAll('.ytp-error, .ytp-error-content, [data-a-target*="gate"], [data-a-target*="error"], [class*="offline"], [role="alert"]')].filter(shown);
  const text = [...adEls, ...over].map((e) => e.innerText.replace(/\\s+/g, " ").trim()).filter((x) => x !== "").join(" | ").slice(0, 200);
  const v = document.querySelector("video");
  return { t: Date.now(), currentTime: v?.currentTime ?? 0, paused: v?.paused ?? true, ad, text };
})()`;

/** The provider iframe of `r`'s room for this attempt, as a raw-CDP target (site isolation puts it in its own process). */
async function playerOf(r: Raw, match: (url: URL) => boolean): Promise<RawTab | null> {
  const t = (await cdpTargets(r.port).catch(() => [])).find((x) => x.type === "iframe" && URL.canParse(x.url) && match(new URL(x.url)));
  return t === undefined ? null : rawTab(t.webSocketDebuggerUrl);
}

interface Sample {
  readonly at: number;
  readonly a: PlayerState | null;
  readonly b: PlayerState | null;
  readonly pa: PageState;
  readonly pb: PageState;
}

interface Attempt {
  readonly provider: "youtube" | "twitch";
  readonly url: string;
  readonly startedAt: string;
  readonly adOn: { a: boolean; b: boolean };
  readonly adMs: { a: number; b: number };
  readonly live: boolean | null;
  /** What each player showed at the end of the attempt. */
  readonly shown: { a: PlayerState | null; b: PlayerState | null };
  readonly duringAd: { roomEverPaused: boolean; otherSawCatching: boolean } | null;
  /** ms from the end of the ad until the two players are within SPREAD_MS (VOD) or the tag cleared (live); null if never. */
  readonly rejoinMs: number | null;
  readonly samples: number;
}

const offset = (x: PlayerState, y: PlayerState): number => Math.abs((x.currentTime - (y.currentTime + (x.t - y.t) / 1000)) * 1000);

/** One share and watch: samples both players and both rooms every 500 ms, waits out an ad if one comes, then the rejoin. */
async function attempt(request: Parameters<typeof shareUrl>[0], a: Raw, b: Raw, provider: Attempt["provider"], url: string, match: (u: URL) => boolean, key: string): Promise<Attempt> {
  const startedAt = new Date().toISOString();
  await shareUrl(request, url);
  const t0 = Date.now();
  let fa: RawTab | null = null;
  let fb: RawTab | null = null;
  const samples: Sample[] = [];
  let firstAd: number | null = null;
  let adEnd: number | null = null;
  let rejoin: number | null = null;
  let shotAd = false;
  for (;;) {
    const at = Date.now() - t0;
    fa ??= await playerOf(a, match);
    fb ??= await playerOf(b, match);
    const [sa, sb, pa, pb] = await Promise.all([
      fa?.eval<PlayerState>(PLAYER_PROBE).catch(() => null) ?? null,
      fb?.eval<PlayerState>(PLAYER_PROBE).catch(() => null) ?? null,
      pageState(a),
      pageState(b),
    ]);
    samples.push({ at, a: sa, b: sb, pa, pb });
    const anyAd = sa?.ad === true || sb?.ad === true;
    if (anyAd && firstAd === null) firstAd = at;
    if (anyAd && !shotAd) {
      shotAd = true;
      await Promise.all([a.tab.screenshot(join(EVIDENCE_DIR, `m3-ad${TAG}-${key}-a-ad.png`)), b.tab.screenshot(join(EVIDENCE_DIR, `m3-ad${TAG}-${key}-b-ad.png`))]);
    }
    if (firstAd !== null && !anyAd && adEnd === null) adEnd = at;
    if (adEnd !== null && rejoin === null && sa !== null && sb !== null && !sa.paused && !sb.paused) {
      const back = provider === "twitch" ? pa.catchingTags.length === 0 && pb.catchingTags.length === 0 : offset(sa, sb) <= SPREAD_MS;
      if (back) rejoin = at - adEnd;
    }
    const done = firstAd === null ? at >= WATCH_MS : adEnd !== null ? rejoin !== null || at - adEnd > 15_000 : at - firstAd > AD_MAX_MS;
    if (done) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await Promise.all([a.tab.screenshot(join(EVIDENCE_DIR, `m3-ad${TAG}-${key}-a.png`)), b.tab.screenshot(join(EVIDENCE_DIR, `m3-ad${TAG}-${key}-b.png`))]);
  fa?.close();
  fb?.close();
  const last = samples.at(-1);
  const adMs = (side: "a" | "b"): number => samples.filter((s) => s[side]?.ad === true).length * 500;
  const during = samples.filter((s) => s.a?.ad === true || s.b?.ad === true);
  const result: Attempt = {
    provider,
    url,
    startedAt,
    adOn: { a: adMs("a") > 0, b: adMs("b") > 0 },
    adMs: { a: adMs("a"), b: adMs("b") },
    live: provider === "twitch" ? samples.some((s) => (s.a !== null && !s.a.paused && s.a.currentTime > 1) || s.a?.ad === true) : null,
    shown: { a: last?.a ?? null, b: last?.b ?? null },
    duringAd: during.length === 0 ? null : {
      roomEverPaused: during.some((s) => s.pa.playing === false || s.pb.playing === false),
      // The member in the ad shows the hourglass on the *other* member's screen.
      otherSawCatching: during.some((s) => (s.a?.ad === true && s.pb.catchingTags.includes(a.name)) || (s.b?.ad === true && s.pa.catchingTags.includes(b.name))),
    },
    rejoinMs: rejoin,
    samples: samples.length,
  };
  record(`m3-ad${TAG}-${key}`, { ...result, trace: during.length === 0 ? [] : samples });
  return result;
}

/** A logged-out youtube.com watch page (not an embed): does this profile and address get pre-rolls at all? */
async function watchPageControl(r: Raw, id: string, label = `control-${id}`): Promise<{ id: string; startedAt: string; host: string; ad: boolean; text: string }> {
  const startedAt = new Date().toISOString();
  await r.tab.eval(`location.href = "https://www.youtube.com/watch?v=${id}"`);
  let seen = { host: "", ad: false, text: "" };
  const t0 = Date.now();
  while (Date.now() - t0 < WATCH_MS && !seen.ad) {
    await new Promise((res) => setTimeout(res, 1_000));
    seen = await r.tab.eval<{ host: string; ad: boolean; text: string }>(`(() => {
      const p = document.querySelector(".html5-video-player");
      const t = [...document.querySelectorAll(".ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-simple-ad-badge")].map((e) => e.innerText.trim()).join(" | ");
      return { host: location.host, ad: p?.classList.contains("ad-showing") ?? false, text: t.slice(0, 200) }; })()`).catch(() => seen);
  }
  await r.tab.screenshot(join(EVIDENCE_DIR, `m3-ad${TAG}-${label}.png`));
  return { id, startedAt, ...seen };
}

test("A · real pre-roll attempt: 2 raw-CDP logged-out profiles, monetised YouTube videos + live Twitch channels", async ({ request }) => {
  const a = await launch("ads-a", 9351);
  const b = await launch("ads-b", 9352);
  const attempts: Attempt[] = [];
  const controls: Awaited<ReturnType<typeof watchPageControl>>[] = [];
  const warmed: Awaited<ReturnType<typeof watchPageControl>>[] = [];
  try {
    if (WARM) for (const r of [a, b]) warmed.push(await watchPageControl(r, YT[0] ?? "dQw4w9WgXcQ", `warm-${r.name}`));
    await enterLobby(a);
    await enterLobby(b);
    for (const id of YT) {
      attempts.push(await attempt(request, a, b, "youtube", embedUrl(id), (u) => u.pathname === `/embed/${id}`, `yt-${id}`));
    }
    let live = 0;
    for (const channel of TWITCH) {
      if (live >= TWITCH_WANTED) break;
      const x = await attempt(request, a, b, "twitch", twitchLiveUrl(channel), (u) => u.host === "player.twitch.tv" && u.searchParams.get("channel") === channel, `tw-${channel}`);
      attempts.push(x);
      if (x.live === true) live++;
    }
    // The control runs last, in b, so the room attempts above saw a profile that had never visited youtube.com.
    for (const id of YT.slice(0, 2)) controls.push(await watchPageControl(b, id));
  } finally {
    a.tab.close();
    b.tab.close();
    a.proc.kill();
    b.proc.kill();
  }
  const ads = attempts.filter((x) => x.adOn.a || x.adOn.b);
  const summary = {
    browser: BROWSER,
    youtube: attempts.filter((x) => x.provider === "youtube").length,
    twitchLive: attempts.filter((x) => x.provider === "twitch" && x.live === true).length,
    adsServed: ads.length,
    attempts: attempts.map(({ provider, url, startedAt, adOn, adMs, live, shown, duringAd, rejoinMs }) => ({ provider, url, startedAt, adOn, adMs, live, shown, duringAd, rejoinMs })),
    controls,
    warmed,
  };
  record(`m3-ads${TAG}`, summary);
  expect(summary.youtube).toBeGreaterThanOrEqual(5);
  expect(summary.twitchLive, `3 live Twitch channels among ${TWITCH.join(", ")}`).toBeGreaterThanOrEqual(TWITCH_WANTED);
  for (const x of ads) {
    expect(x.duringAd?.roomEverPaused, `${x.url}: the room keeps playing through one member's ad`).toBe(false);
    // Only a one-sided ad makes one member catch up; if both got it, there's no one else to see the tag.
    if (x.adOn.a !== x.adOn.b) expect(x.duringAd?.otherSawCatching, `${x.url}: the other member sees the catching-up tag`).toBe(true);
    expect(x.rejoinMs, `${x.url}: back in sync after the ad`).not.toBeNull();
  }
  if (ads.length === 0) test.info().annotations.push({ type: "known gap", description: "no real pre-roll served; the fake-SDK ad cases stay the regression guard" });
});
