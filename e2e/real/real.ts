// Helpers for the opt-in real-YouTube run (OME-91, docs/qa/m1b-real-youtube.md). Real network, headed Chromium, never in CI.
// Nothing here stubs YouTube: the site's real loader, adapter and sync loop talk to the real IFrame API and player.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { APIRequestContext, Browser, BrowserContext, Frame, Page } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import type { PlaybackView } from "../../apps/web/src/controls/playback";
import { ROOT, URLS } from "../support/apps";
import { site } from "../support/selectors";

export const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;
const SHARE_URL = `${URLS.server}/rooms/${DEFAULT_ROOM_ID}/share`;
/** Not under test-results/: Playwright empties that at the start of every run. Git-ignored. */
export const EVIDENCE_DIR = join(ROOT, "e2e/real/results");

/** Open-licensed, embeddable, not monetized (Blender's Big Buck Bunny): the steady baseline. */
export const BASELINE_ID = "aqz-KE-bpKQ";
/** Monetized and embeddable: the best chance of a pre-roll ad. Override with OMEGA_REAL_AD_IDS (comma-separated). */
export const AD_IDS = (process.env["OMEGA_REAL_AD_IDS"] ?? "dQw4w9WgXcQ,kJQP7kiw5Fk,JGwWNGJdvx8,OPf0YbXqDm0,09R8_2nJtjg,fRh_vgS2dFE").split(",");

export const embedUrl = (id: string): string => `https://www.youtube.com/embed/${id}`;

declare global {
  interface Window {
    /** Dev builds only (apps/web/src/main.ts): what the playback chrome shows. */
    __omega?: { readonly room: { playback(): PlaybackView } | null };
  }
}

export interface Client {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly nickname: string;
}

/** Collects CSP violations and the widget script's URL + status from the first document on. */
export async function watchPage(page: Page): Promise<{ readonly widget: { url: string; status: number }[] }> {
  const widget: { url: string; status: number }[] = [];
  page.on("response", (r) => {
    if (/\/s\/player\/[^/]+\/www-widgetapi\.vflset\/www-widgetapi\.js$/.test(r.url())) widget.push({ url: r.url(), status: r.status() });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
  return { widget };
}

export const cspViolations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);

/** Join the lobby through the landing form with a real click (the "Enter room" user activation). */
export async function enter(context: BrowserContext, nickname: string): Promise<Client> {
  const page = await context.newPage();
  await page.goto(ROOM_URL);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  await page.locator(site.room).waitFor();
  return { context, page, nickname };
}

export async function share(request: APIRequestContext, id: string): Promise<void> {
  await expect
    .poll(async () => (await request.post(SHARE_URL, { data: { url: embedUrl(id) } })).status(), { timeout: 20_000, intervals: [1_000] })
    .toBe(200);
}

/** The YouTube player frame (cross-origin, but Playwright can evaluate in it). */
export async function ytFrame(page: Page, id: string, timeout = 20_000): Promise<Frame> {
  const find = (): Frame | undefined => page.frames().find((f) => URL.canParse(f.url()) && new URL(f.url()).pathname === `/embed/${id}`);
  await expect.poll(() => find() !== undefined, { timeout, message: `player frame for ${id}` }).toBe(true);
  const found = find();
  if (found === undefined) throw new Error(`player frame for ${id} went away`);
  return found;
}

export interface VideoSample {
  /** Epoch ms when sampled (one machine, so comparable across pages). */
  readonly t: number;
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly ad: boolean;
  /** YouTube's own error/unplayable overlay text, if any. */
  readonly errorText: string;
}

/** Read the real `<video>` inside the player iframe. */
export function sampleVideo(frame: Frame): Promise<VideoSample | null> {
  return frame.evaluate(() => {
    const v = document.querySelector("video");
    const player = document.querySelector(".html5-video-player");
    const err = document.querySelector(".ytp-error, .ytp-error-content");
    if (v === null) {
      return err === null ? null : { t: Date.now(), currentTime: 0, playbackRate: 0, paused: true, muted: false, volume: 0, ad: false, errorText: err.textContent.trim() };
    }
    return {
      t: Date.now(),
      currentTime: v.currentTime,
      playbackRate: v.playbackRate,
      paused: v.paused,
      muted: v.muted,
      volume: v.volume,
      ad: player?.classList.contains("ad-showing") ?? false,
      errorText: err instanceof HTMLElement && err.offsetParent !== null ? err.textContent.trim() : "",
    };
  });
}

export async function waitVideoPlaying(frame: Frame, timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => {
      const s = await sampleVideo(frame);
      return s !== null && !s.paused && !s.ad && s.currentTime > 0.5;
    }, { timeout, intervals: [250], message: "real video playing" })
    .toBe(true);
}

/** Least-squares slope of y over x. */
export function slope(points: readonly (readonly [number, number])[]): number {
  const n = points.length;
  if (n < 2) return Number.NaN;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of points) {
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

/**
 * Offset between two players in ms, from one near-simultaneous sample each: how far `a` is ahead of `b`,
 * after moving `b`'s reading to `a`'s sample time at 1×.
 */
export const offsetMs = (a: VideoSample, b: VideoSample): number => (a.currentTime - (b.currentTime + (a.t - b.t) / 1000)) * 1000;

/** Worst |offset| over `n` sample pairs `everyMs` apart. */
export async function spreadOver(a: Frame, b: Frame, n: number, everyMs: number): Promise<{ maxAbsMs: number; samplesMs: number[] }> {
  const samplesMs: number[] = [];
  for (let i = 0; i < n; i++) {
    const [sa, sb] = await Promise.all([sampleVideo(a), sampleVideo(b)]);
    if (sa !== null && sb !== null && !sa.paused && !sb.paused && !sa.ad && !sb.ad) samplesMs.push(Math.round(offsetMs(sa, sb)));
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { maxAbsMs: Math.max(...samplesMs.map(Math.abs)), samplesMs };
}

/** Evidence file per checklist item: `e2e/real/results/<name>.json` (+ screenshots next to it). */
export function record(name: string, data: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`[real-youtube] ${name}: ${JSON.stringify(data)}`);
}

export const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: join(EVIDENCE_DIR, `${name}.png`) });

export async function closeAll(...things: readonly (BrowserContext | Browser)[]): Promise<void> {
  await Promise.all(things.map((t) => t.close()));
}

/**
 * Minimal raw-CDP client. Playwright hands every page a user activation within ~20 ms of loading (measured on OME-91:
 * `navigator.userActivation.hasBeenActive` flips with no input at all), so the "sound blocked" path can only be reached
 * in a Chromium that Playwright doesn't drive. Everything here uses `userGesture: false` except `click()`, which is a
 * trusted mouse event like a user's.
 */
export interface RawTab {
  eval<T>(expression: string): Promise<T>;
  click(selector: string): Promise<void>;
  screenshot(path: string): Promise<void>;
  close(): void;
}

export async function rawTab(wsUrl: string): Promise<RawTab> {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let next = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.addEventListener("message", (m) => {
    const d: unknown = JSON.parse(String(m.data));
    if (typeof d !== "object" || d === null || !("id" in d) || typeof d.id !== "number") return;
    pending.get(d.id)?.("result" in d ? d.result : null);
    pending.delete(d.id);
  });
  const send = (method: string, params: object = {}): Promise<unknown> =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  // Frames only flow to a tab the browser treats as in front and focused (Playwright does the same).
  await send("Page.bringToFront");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const tab: RawTab = {
    async eval<T>(expression: string): Promise<T> {
      const r = await send("Runtime.evaluate", { expression, userGesture: false, returnByValue: true, awaitPromise: true });
      const value = typeof r === "object" && r !== null && "result" in r && typeof r.result === "object" && r.result !== null && "value" in r.result ? r.result.value : undefined;
      return value as T;
    },
    async click(selector: string) {
      const rect = await tab.eval<string | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
        e.scrollIntoView({ block: "center" }); return JSON.stringify(e.getBoundingClientRect()); })()`);
      if (rect === null) throw new Error(`no ${selector}`);
      await new Promise((r) => setTimeout(r, 300));
      const box: unknown = JSON.parse(await tab.eval<string>(`JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`));
      if (typeof box !== "object" || box === null || !("x" in box) || !("y" in box) || !("width" in box) || !("height" in box)) throw new Error("bad rect");
      const x = Number(box.x) + Number(box.width) / 2;
      const y = Number(box.y) + Number(box.height) / 2;
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    async screenshot(path: string) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (typeof r === "object" && r !== null && "data" in r && typeof r.data === "string") {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        writeFileSync(path, Buffer.from(r.data, "base64"));
      }
    },
    close() {
      ws.close();
    },
  };
  return tab;
}

export interface CdpTarget { readonly type: string; readonly url: string; readonly webSocketDebuggerUrl: string }

export async function cdpTargets(port: number): Promise<CdpTarget[]> {
  const r: unknown = await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json();
  if (!Array.isArray(r)) return [];
  return r.filter((t): t is CdpTarget => typeof t === "object" && t !== null && "type" in t && "url" in t && "webSocketDebuggerUrl" in t);
}
