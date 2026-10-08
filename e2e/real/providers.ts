// Helpers for the opt-in real Twitch / Vimeo run (OME-133, docs/qa/m2-real-sign-off.md). Real network, headed, never in CI.
// Like real.ts for YouTube: nothing is stubbed. The spec reads the real <video> inside each provider's player iframe.
import { expect } from "@playwright/test";
import type { Frame, Page } from "@playwright/test";
import { site } from "../support/selectors";
import type { Client } from "./real";
import { heldMaxAbsMs, needsConfirmSample } from "./spread";
import { roomView, type RoomView } from "./room-view";

export type RealProvider = "twitch" | "vimeo";

const HOSTS: Readonly<Record<RealProvider, string>> = { twitch: "player.twitch.tv", vimeo: "player.vimeo.com" };

/**
 * Real ids, overridable because Twitch VODs expire and channels go on and off air. Pick fresh ones on twitch.tv:
 * a VOD from the Videos tab (uploads don't expire), a live channel from Browse, a mature one (the "Mature" tag).
 */
const list = (v: string): string[] => v.split(",").map((x) => x.trim()).filter((x) => x !== "");

export const REAL = {
  /** An upload on the official `twitch` channel (72 min), so it doesn't expire like past broadcasts. */
  twitchVod: process.env["OMEGA_REAL_TWITCH_VOD"] ?? "2784566594",
  /** Candidates, in order: the spec uses the first one live when it runs, and skips (with the list) if none is. */
  twitchLive: list(process.env["OMEGA_REAL_TWITCH_LIVE"] ?? "valorant,caedrel,esl_csgo,riotgames,kaicenat,xqc"),
  /**
   * Live and flagged mature. Twitch's embed often plays these ungated for a logged-out viewer (OME-218): then there is
   * nothing to refuse, and the case is recorded as not run instead of failing.
   */
  twitchMature: process.env["OMEGA_REAL_TWITCH_MATURE"] ?? "ironmouse",
  /**
   * Live channels that show Twitch's content-classification gate ("Mature-rated game", Start Watching) to a logged-out
   * viewer (OME-246). Unset: picked at run time from `twitchGatedCategories`, since who is live changes by the hour.
   */
  twitchGated: list(process.env["OMEGA_REAL_TWITCH_GATED"] ?? ""),
  /** Twitch directory categories for M-rated games, whose streams carry the "Mature-rated game" label. */
  twitchGatedCategories: list(process.env["OMEGA_REAL_TWITCH_GATED_CATEGORIES"] ?? "grand-theft-auto-v,call-of-duty-warzone,dead-by-daylight"),
  /** A real login with no stream right now (Twitch's developer channel is rarely live). */
  twitchOffline: process.env["OMEGA_REAL_TWITCH_OFFLINE"] ?? "twitchdev",
  /** No such login. */
  twitchNoSuchChannel: "omegatestchannel",
  /** Blender's Big Buck Bunny (597 s, free account, so its rate is likely locked → seek-only fallback). */
  vimeo: process.env["OMEGA_REAL_VIMEO"] ?? "1084537",
  /** No such video (`player.vimeo.com/video/<id>/config` is 404): the not-found path. */
  vimeoGone: process.env["OMEGA_REAL_VIMEO_GONE"] ?? "999999999999",
  /** Optional: a domain-restricted video (PrivacyError). There's no public one we know of, so unset means not run. */
  vimeoRefused: process.env["OMEGA_REAL_VIMEO_REFUSED"],
} as const;

export const twitchVodUrl = (id: string): string => `https://www.twitch.tv/videos/${id}`;
export const twitchLiveUrl = (login: string): string => `https://www.twitch.tv/${login}`;
export const vimeoUrl = (id: string): string => `https://vimeo.com/${id}`;

/** The room as this page shows it: __omega on a dev build, the DOM on a production build (the hosted origin). */
export const view = (page: Page): Promise<RoomView> => roomView(page);

/**
 * The provider's player frame for `id` (a Twitch channel / `v<id>`, a Vimeo id): cross-origin, but Playwright can
 * evaluate in it. Matching the id matters on a re-share, when the previous embed's frame may still be detaching.
 */
export async function providerFrame(page: Page, provider: RealProvider, id: string, timeout = 30_000): Promise<Frame> {
  const matches = (f: Frame): boolean => {
    if (!URL.canParse(f.url()) || f.isDetached()) return false;
    const u = new URL(f.url());
    if (u.host !== HOSTS[provider]) return false;
    return provider === "vimeo" ? u.pathname === `/video/${id}` : u.searchParams.get("channel") === id || u.searchParams.get("video") === id;
  };
  const find = (): Frame | undefined => page.frames().find(matches);
  await expect.poll(() => find() !== undefined, { timeout, message: `${provider} player frame for ${id}` }).toBe(true);
  const found = find();
  if (found === undefined) throw new Error(`${provider} player frame for ${id} went away`);
  return found;
}

export interface MediaSample {
  /** Epoch ms when sampled (one machine, so comparable across browsers). */
  readonly t: number;
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly paused: boolean;
  /** Twitch's ad label / countdown is showing. */
  readonly ad: boolean;
  /** Visible overlay text in the player (errors, content gates, "offline"), trimmed to 200 chars. */
  readonly overlay: string;
}

/** The player's own <video>, plus any ad marker and the text of any overlay covering it. */
export function sampleMedia(frame: Frame): Promise<MediaSample | null> {
  return frame
    .evaluate(() => {
      const shown = (e: Element | null): e is HTMLElement => e instanceof HTMLElement && e.offsetParent !== null;
      const ad = [...document.querySelectorAll('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], [class*="video-ad"]')].some(shown);
      const overlays = [
        ...document.querySelectorAll(
          '[data-a-target*="gate"], [data-a-target*="mature"], [data-a-target="player-overlay-content-gate"], [data-a-target*="error"], .content-overlay-gate, [class*="error"], [class*="offline"], .vp-alert, .vp-error, [role="alert"]',
        ),
      ].filter(shown);
      const overlay = overlays.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter((x) => x !== "").join(" | ").slice(0, 200);
      const v = document.querySelector("video");
      if (v === null) return overlay === "" ? null : { t: Date.now(), currentTime: 0, playbackRate: 0, paused: true, ad, overlay };
      return { t: Date.now(), currentTime: v.currentTime, playbackRate: v.playbackRate, paused: v.paused, ad, overlay };
    })
    .catch(() => null);
}

export interface AdTrace {
  readonly t: number;
  readonly ad: boolean;
  readonly roomPlaying: boolean | null;
  readonly catching: boolean | null;
}

/**
 * Waits until the real video plays content (no ad), recording any ad on the way and what the room did meanwhile:
 * logged-out Twitch viewers often get a pre-roll. `timeout` covers a 30–90 s ad break.
 */
export async function waitMediaPlaying(c: Client, frame: Frame, timeout = 120_000): Promise<AdTrace[]> {
  const trace: AdTrace[] = [];
  const t0 = Date.now();
  for (;;) {
    const [s, v] = await Promise.all([sampleMedia(frame), view(c.page)]);
    trace.push({ t: Date.now() - t0, ad: s?.ad ?? false, roomPlaying: v.playing, catching: v.catching });
    if (s !== null && !s.paused && !s.ad && s.currentTime > 0.5) return trace.filter((x) => x.ad);
    if (Date.now() - t0 > timeout) throw new Error(`${c.nickname}: real video not playing after ${String(timeout)} ms (last: ${JSON.stringify(s)})`);
    await c.page.waitForTimeout(500);
  }
}

/** How far `a` is ahead of `b` in ms, after moving `b`'s reading to `a`'s sample time at `b`'s rate. */
const offsetMs = (a: MediaSample, b: MediaSample): number => (a.currentTime - (b.currentTime + ((a.t - b.t) / 1000) * b.playbackRate)) * 1000;

/**
 * Offsets over `n` sample pairs `everyMs` apart; pairs where either side is paused or in an ad are skipped.
 * `maxAbsMs` is the plain worst, kept as evidence; `heldMaxAbsMs` is what budgets check (see ./spread.ts, OME-377).
 * A window that ends over `budgetMs` takes up to two more samples, so a drift starting at its end still shows.
 */
export async function mediaSpread(a: Frame, b: Frame, n: number, everyMs: number, budgetMs = Infinity): Promise<{ maxAbsMs: number; heldMaxAbsMs: number; samplesMs: number[] }> {
  const samplesMs: number[] = [];
  for (let i = 0; i < n + 2; i++) {
    if (i >= n && !needsConfirmSample(samplesMs, budgetMs)) break;
    const [sa, sb] = await Promise.all([sampleMedia(a), sampleMedia(b)]);
    if (sa !== null && sb !== null && !sa.paused && !sb.paused && !sa.ad && !sb.ad) samplesMs.push(Math.round(offsetMs(sa, sb)));
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { maxAbsMs: samplesMs.length === 0 ? Number.NaN : Math.max(...samplesMs.map(Math.abs)), heldMaxAbsMs: heldMaxAbsMs(samplesMs), samplesMs };
}

/** Our shared seek bar, driven like a user dragging it. */
export async function seekTo(page: Page, seconds: number): Promise<void> {
  await page.locator(site.seek).evaluate((el, s) => {
    if (!(el instanceof HTMLInputElement)) return;
    el.value = String(Math.min(Number(el.max) || s, s));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, seconds);
}

/**
 * Ms from `start` until every frame's <video> reaches `paused`, polled every 50 ms for up to `timeout`.
 * Null for a frame that never got there. Live streams have no comparable position, so arrival is the spread.
 */
export async function arrival(frames: readonly Frame[], paused: boolean, start: number, timeout = 6_000): Promise<(number | null)[]> {
  const at: (number | null)[] = frames.map(() => null);
  while (Date.now() - start < timeout && at.some((x) => x === null)) {
    const s = await Promise.all(frames.map((f) => sampleMedia(f)));
    s.forEach((x, i) => {
      if (at[i] === null && x !== null && x.paused === paused && !x.ad) at[i] = Date.now() - start;
    });
    await new Promise((r) => setTimeout(r, 50));
  }
  return at;
}

/** Twitch's content-classification gate button, inside the cross-origin player (seen 2026-10-01, OME-246). */
export const TWITCH_START_WATCHING = '[data-a-target="content-classification-gate-overlay-start-watching-button"]';

/** Twitch's content-classification gate is showing in this player frame. */
export const gateShown = (frame: Frame): Promise<boolean> => frame.locator(TWITCH_START_WATCHING).isVisible().catch(() => false);

/** The first `perCategory` live channels listed on each Twitch directory category page (logged out, top viewers first). */
export async function liveInCategories(page: Page, categories: readonly string[], perCategory = 3): Promise<string[]> {
  const found: string[] = [];
  for (const c of categories) {
    await page.goto(`https://www.twitch.tv/directory/category/${c}`, { waitUntil: "domcontentloaded" });
    await page.locator('a[data-a-target="preview-card-channel-link"]').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    const logins = await page.locator('a[data-a-target="preview-card-channel-link"]').evaluateAll((as) => as.map((a) => (a instanceof HTMLAnchorElement ? (new URL(a.href).pathname.split("/")[1] ?? "") : "")));
    found.push(...logins.filter((x) => x !== "").slice(0, perCategory));
  }
  return [...new Set(found)];
}

/** The site's visible notices (player-error / mount / sync / system line). */
export const siteNotices = (page: Page): Promise<string[]> =>
  page
    .locator(`${site.roomNotice}, ${site.syncNotice}, ${site.systemLine}, ${site.catchingNotice}`)
    .evaluateAll((els) => els.filter((e) => e instanceof HTMLElement && !e.hidden && e.offsetParent !== null).map((e) => e.textContent.trim()).filter((t) => t !== ""));
