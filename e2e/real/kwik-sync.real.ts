// OME-1976: ADR 0057 on the real kwik embed. Two profiles with the extension unlock, load and sync (play / pause / seek
// from A's room controls); a third with no extension stays "Not synced" and never follows. Real network, headed on Xvfb:
// `bun run e2e:real -- kwik-sync`. Never in CI. Evidence: e2e/real/results/kwik-sync.json (+ .png).
import { chromium } from "@playwright/test";
import type { Frame, Page } from "@playwright/test";
import { URLS } from "../support/apps";
import { expect, test, watchCsp } from "../support/csp";
import { site } from "../support/selectors";
import { enter, extensionDir, offsetMs, profile, record, requireVirtualDisplay, shareUrl, shot } from "./real";
import type { VideoSample } from "./real";
import { seekTo } from "./providers";
import { heldMaxAbsMs } from "./spread";

test.beforeAll(requireVirtualDisplay);
test.setTimeout(300_000);

const KWIK = "https://kwik.cx/e/ockxKpNdX2Kh";
const BUDGET_MS = 500;
const SEEK_TO = 300;

const isKwik = (f: Frame | null): boolean => f !== null && !f.isDetached() && URL.canParse(f.url()) && new URL(f.url()).hostname === "kwik.cx";
const kwikFrames = (page: Page): Frame[] => page.frames().filter(isKwik);

// The first <video> in the frame or its same-origin subframes (kwik nests its player).
const SAMPLE = `(() => {
  const find = (d) => d.querySelector("video") ?? [...d.querySelectorAll("iframe")].map((f) => { try { return f.contentDocument && find(f.contentDocument); } catch { return null; } }).find(Boolean) ?? null;
  const v = find(document);
  return v && { t: Date.now(), currentTime: v.currentTime, playbackRate: v.playbackRate, paused: v.paused, muted: v.muted, volume: v.volume, ad: false, errorText: "" };
})()`;

/**
 * The kwik video, read over raw CDP with no user gesture: Playwright's frame.evaluate grants transient activation, and the
 * frame script (ADR 0057 §5) would then report kwik's own pause/play events as the viewer's intents. Looked up per
 * sample: Unlock recreates the iframe.
 */
async function sample(page: Page): Promise<VideoSample | null> {
  for (const f of kwikFrames(page)) {
    if (isKwik(f.parentFrame())) continue; // nested in the same process: reached from its kwik root
    const cdp = await page.context().newCDPSession(f).catch(() => null);
    if (cdp === null) continue;
    try {
      const r = await cdp.send("Runtime.evaluate", { expression: SAMPLE, userGesture: false, returnByValue: true });
      const s = r.result.value as VideoSample | null | undefined;
      if (s !== null && s !== undefined) return s;
    } catch {
      // detached mid-sample: try the next frame
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }
  return null;
}

/** Held spread between two pages over `n` samples while both play. */
async function spread(a: Page, b: Page, n: number, everyMs: number): Promise<{ heldMaxAbsMs: number; samplesMs: number[] }> {
  const samplesMs: number[] = [];
  for (let i = 0; i < n; i++) {
    const [sa, sb] = await Promise.all([sample(a), sample(b)]);
    if (sa !== null && sb !== null && !sa.paused && !sb.paused) samplesMs.push(Math.round(offsetMs(sa, sb)));
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { heldMaxAbsMs: heldMaxAbsMs(samplesMs), samplesMs };
}

test("kwik · two extension viewers unlock, sync play / pause / seek ≤ 500 ms; a viewer without the extension stays unsynced", async ({ request }) => {
  const dir = extensionDir(["https://kwik.cx/*"]);
  const [a, b] = [await profile(dir, URLS.web), await profile(dir, URLS.web)];
  const cBrowser = await chromium.launch({ headless: false });
  try {
    await shareUrl(request, KWIK);
    const c = await enter(await watchCsp(await cBrowser.newContext()), "kwik-c");
    const ca = await enter(a.context, "kwik-a");
    const cb = await enter(b.context, "kwik-b");

    for (const v of [ca, cb]) {
      await v.page.getByTestId("generic-unlock").click({ timeout: 30_000 });

      await expect(v.page.getByTestId("synced"), "extension viewer is synced").toHaveText("Synced", { timeout: 60_000 });
    }
    await c.page.getByTestId("generic-load").click({ timeout: 30_000 });
    await expect(c.page.getByTestId("not-synced")).toHaveText("Not synced");

    const ready = (p: Page): Promise<void> => expect.poll(async () => (await sample(p)) !== null, { timeout: 60_000, message: "kwik video present" }).toBe(true);
    await Promise.all([ready(ca.page), ready(cb.page)]);
    await c.page.waitForTimeout(5_000);
    const cInitial = await sample(c.page);

    // The default room outlives a run: a previous one can leave it playing. Start from paused.
    const toggle = ca.page.locator(site.playToggle);
    await expect(toggle).toBeEnabled({ timeout: 30_000 });
    if ((await toggle.getAttribute("aria-label")) === "Pause for everyone") {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-label", "Play for everyone");
    }

    // Play from A.
    await toggle.click();
    await ca.page.waitForTimeout(3_000);
    await expect.poll(async () => (await Promise.all([sample(ca.page), sample(cb.page)])).every((s) => s?.paused === false), { timeout: 30_000, message: "A and B playing" }).toBe(true);
    await ca.page.waitForTimeout(3_000);
    const play = await spread(ca.page, cb.page, 12, 250);
    await shot(ca.page, "kwik-sync-a-play");
    await shot(cb.page, "kwik-sync-b-play");

    // Pause.
    await ca.page.locator(site.playToggle).click();
    await expect.poll(async () => (await Promise.all([sample(ca.page), sample(cb.page)])).every((s) => s?.paused === true), { timeout: 15_000, message: "A and B paused" }).toBe(true);
    await ca.page.waitForTimeout(1_500);
    const [pa, pb] = await Promise.all([sample(ca.page), sample(cb.page)]);
    const pausedDiffMs = pa !== null && pb !== null ? Math.round((pa.currentTime - pb.currentTime) * 1000) : null;

    // Seek (room paused: both must land on the target and agree).
    await seekTo(ca.page, SEEK_TO);
    await expect.poll(async () => {
      const [sa, sb] = await Promise.all([sample(ca.page), sample(cb.page)]);
      return sa !== null && sb !== null && Math.abs(sa.currentTime - SEEK_TO) < 2 && Math.abs(sb.currentTime - SEEK_TO) < 2;
    }, { timeout: 5_000, intervals: [250], message: "A and B land on the seek target" }).toBe(true);
    const [sa, sb] = await Promise.all([sample(ca.page), sample(cb.page)]);
    const seekDiffMs = sa !== null && sb !== null ? Math.round((sa.currentTime - sb.currentTime) * 1000) : null;
    await shot(ca.page, "kwik-sync-a-seek");

    const cFinal = await sample(c.page);
    await shot(c.page, "kwik-sync-c");
    record("kwik-sync", {
      url: KWIK,
      kwikFramesA: kwikFrames(ca.page).map((f) => new URL(f.url()).pathname),
      playSpread: play,
      paused: { bothPaused: pa?.paused === true && pb?.paused === true, diffMs: pausedDiffMs },
      seek: { target: SEEK_TO, positions: [sa?.currentTime ?? null, sb?.currentTime ?? null], diffMs: seekDiffMs },
      c: {
        label: await c.page.getByTestId("not-synced").textContent(),
        frames: kwikFrames(c.page).map((f) => f.url()),
        initial: cInitial,
        final: cFinal,
        iframeBox: await c.page.locator('[data-testid="shared-video"]').boundingBox(),
      },
    });

    expect(play.samplesMs.length, "enough play samples").toBeGreaterThanOrEqual(6);
    expect(play.heldMaxAbsMs, "play spread").toBeLessThanOrEqual(BUDGET_MS);
    expect(pa?.paused === true && pb?.paused === true, "pause reaches both").toBe(true);
    expect(Math.abs(pausedDiffMs ?? Infinity), "paused positions").toBeLessThanOrEqual(BUDGET_MS);
    expect(Math.abs(seekDiffMs ?? Infinity), "seek spread").toBeLessThanOrEqual(BUDGET_MS);
    // C never follows: if kwik loaded for it at all, it is not playing, and not at A's seek target.
    if (cFinal !== null) {
      expect(cFinal.paused, "C's player doesn't follow play").toBe(true);
      expect(Math.abs(cFinal.currentTime - SEEK_TO), "C's player doesn't follow seek").toBeGreaterThan(5);
    }
    await expect(c.page.getByTestId("not-synced")).toBeVisible();
  } finally {
    await Promise.all([a.context.close(), b.context.close(), cBrowser.close()]);
  }
});
