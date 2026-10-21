// The Movie night hosted smoke (OME-1650): rows 1-9 of docs/ops/movie-night-deploy.md §4, four browser contexts A
// (owner), B, C and D (late), real YouTube, headed on Xvfb through `bun run e2e:real`. Never in CI.
//   hosted: OMEGA_SMOKE_ORIGIN="$PUBLIC_ORIGIN" bun run e2e:real -- movie-night-smoke
//   local:  bun run e2e:real -- movie-night-smoke   (the lane's own web + server)
// A creates a private room from the home page (POST /rooms: 2 per client per 10 min) and deletes it at the end.
// Rows whose feature hasn't landed are `test.fixme` naming its issue: replace them as the issues merge.
// Evidence (JSON + PNG per row): e2e/real/results/movie-night-*; copy them to docs/qa/movie-night-hosted/ for the deploy.
import { ROOM_SECRETS_STORAGE_KEY, SHARE_TOKEN_STORAGE_KEY } from "@omega/shared";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Frame, Page } from "@playwright/test";
import { expect, test, watchCsp } from "../support/csp";
import { URLS } from "../support/apps";
import { openDirectory } from "../support/directory";
import { site } from "../support/selectors";
import { BASELINE_ID, embedUrl, record, requireVirtualDisplay, sampleVideo, shot, spreadOver, waitVideoPlaying, ytFrame } from "./real";

test.beforeAll(requireVirtualDisplay);
// Serial: each row builds on the last. Timings are soft asserts, so one slow row still lets the rest run and record.
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const HOSTED = process.env["OMEGA_SMOKE_ORIGIN"]?.replace(/\/$/, "");
/** The site and the API: one origin when hosted; the lane's two local servers otherwise. */
const WEB = HOSTED ?? URLS.web;
const API = HOSTED ?? URLS.server;
const SYNC_MS = 500;
/** Body of a `test.fixme` row: it never runs. */
const pending = (): void => undefined;

interface Member {
  readonly name: "A" | "B" | "C" | "D";
  readonly context: BrowserContext;
  page: Page;
  readonly consoleErrors: string[];
}

let browser: Browser;
let roomId = "";
let roomUrl = "";
let ownerToken = "";
const members: Member[] = [];
const by = (name: Member["name"]): Member => {
  const m = members.find((x) => x.name === name);
  if (m === undefined) throw new Error(`${name} hasn't joined`);
  return m;
};

async function newMember(name: Member["name"]): Promise<Member> {
  const context = await watchCsp(await browser.newContext());
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  // Only the site's own errors: the YouTube player logs its own noise.
  page.on("console", (msg) => {
    const url = msg.location().url;
    // The local Vite dev server has no favicon (the hosted site serves one).
    if (HOSTED === undefined && url === `${WEB}/favicon.ico`) return;
    if (msg.type() === "error" && url.startsWith(WEB)) consoleErrors.push(`${msg.text()} ${url}`);
  });
  const m = { name, context, page, consoleErrors };
  members.push(m);
  return m;
}

/** Fills the landing form (if the page shows it) and waits for the room. */
async function enter(page: Page, nickname: string): Promise<void> {
  const input = page.locator(site.nicknameInput);
  await expect.poll(async () => (await input.isVisible()) || (await page.locator(site.room).isVisible()), { timeout: 20_000 }).toBe(true);
  if (await input.isVisible()) {
    await input.fill(nickname);
    await page.locator(site.joinButton).click();
  }
  await page.locator(site.room).waitFor();
}

async function join(name: Member["name"]): Promise<Member> {
  const m = await newMember(name);
  await m.page.goto(roomUrl);
  await enter(m.page, `smoke-${name}`);
  return m;
}

const seat = (page: Page, i: number) => page.locator(`${site.seat}[data-seat="${String(i)}"]`);

async function shareToken(page: Page): Promise<string> {
  const read = (): Promise<string | null> => page.evaluate((k) => sessionStorage.getItem(k), SHARE_TOKEN_STORAGE_KEY);
  await expect.poll(read, { timeout: 10_000 }).not.toBeNull();
  const rec: unknown = JSON.parse((await read()) ?? "null");
  if (typeof rec !== "object" || rec === null || !("token" in rec) || typeof rec.token !== "string") throw new Error("no share token record");
  return rec.token;
}

/** ms from `act` until `done` holds on every frame (50 ms polling; the e2e sync spec's click → player reading). */
async function followMs(act: () => Promise<void>, frames: readonly Frame[], done: (s: NonNullable<Awaited<ReturnType<typeof sampleVideo>>>) => boolean): Promise<number[]> {
  const t0 = Date.now();
  await act();
  return Promise.all(frames.map(async (f) => {
    while (Date.now() - t0 < 10_000) {
      const s = await sampleVideo(f);
      if (s !== null && done(s)) return Date.now() - t0;
      await new Promise((r) => setTimeout(r, 50));
    }
    return Number.POSITIVE_INFINITY;
  }));
}

async function seekTo(page: Page, seconds: number): Promise<void> {
  await page.locator(site.seek).evaluate((el, s) => {
    if (!(el instanceof HTMLInputElement)) return;
    el.value = String(s);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, seconds);
}

test.beforeAll(async () => {
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  record("movie-night-console", Object.fromEntries(members.map((m) => [m.name, m.consoleErrors])));
  // Delete the room even when a row failed: a hosted run must leave nothing behind.
  if (roomId !== "" && ownerToken !== "") {
    const res = await fetch(`${API}/rooms/${roomId}`, { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}`, origin: WEB } });
    record("movie-night-cleanup", { deleted: res.status });
  }
  await browser.close();
});

test("row 1 · join: A creates a private room; A, B, C open it and see each other, no reconnect line", async () => {
  const a = await newMember("A");
  await a.page.goto(`${WEB}/`);
  await openDirectory(a.page, "smoke-A");
  await a.page.locator(site.createRoomTitle).fill(`QA smoke ${new Date().toISOString().slice(0, 10)}`);
  await a.page.locator(site.createRoomPrivate).check();
  await a.page.locator(site.createRoomSubmit).click();
  await a.page.waitForURL(/\/r\/[a-z2-7]{26}$/);
  roomId = new URL(a.page.url()).pathname.split("/")[2] ?? "";
  const secrets: unknown = JSON.parse((await a.page.evaluate((k) => localStorage.getItem(k), ROOM_SECRETS_STORAGE_KEY)) ?? "{}");
  const rooms: unknown = typeof secrets === "object" && secrets !== null && "rooms" in secrets ? secrets.rooms : null;
  const mine: unknown = typeof rooms === "object" && rooms !== null ? Object.entries(rooms).find(([k]) => k === roomId)?.[1] : null;
  if (typeof mine === "object" && mine !== null && "ownerToken" in mine && typeof mine.ownerToken === "string") ownerToken = mine.ownerToken;
  expect(ownerToken, "owner token stored").toMatch(/^[A-Za-z0-9_-]{22}$/);
  await enter(a.page, "smoke-A");
  roomUrl = await a.page.locator(site.inviteLink).inputValue();
  expect(roomUrl.startsWith(`${WEB}/r/${roomId}#k=`)).toBe(true);

  await Promise.all([join("B"), join("C")]);
  const abc = members.slice(0, 3);
  for (const m of abc) {
    await expect(m.page.locator(site.nicknameTag), `${m.name} sees A, B, C`).toHaveCount(3, { timeout: 10_000 });
    await expect(m.page.locator(site.connectionStatus)).toHaveText("");
  }
  await shot(a.page, "movie-night-1-join");
  record("movie-night-1", { web: WEB, hosted: HOSTED !== undefined, https: a.page.url().startsWith("https://") });
  if (HOSTED !== undefined) expect(a.page.url().startsWith("https://")).toBe(true);
});

test.fixme("row 1b · join.batch opt-in: relay frames arrive as `batch` (OME-1627)", pending);

test("row 2 · sit: A, B, C take seats; every context sees each within 500 ms; no seat is double-booked", async () => {
  // shortcut: plain seats 0-2 of the default layout; the theatre preset (OME-1630) replaces this once it lands.
  const abc = [by("A"), by("B"), by("C")];
  const seen: Record<string, number[]> = {};
  for (const [i, m] of abc.entries()) {
    // Armed before the click, polled per frame: when each page shows the seat taken. The sitter may walk there first,
    // so the others are measured from the sitter's own page, not from the click.
    const taken = abc.map((o) => o.page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-occupied") === "true",
      `${site.seat}[data-seat="${String(i)}"]`, { polling: "raf", timeout: 10_000 }).then(() => Date.now()));
    await seat(m.page, i).click();
    const at = await Promise.all(taken);
    const own = at[i] ?? Number.NaN;
    seen[m.name] = at.map((t) => t - own);
  }
  for (const o of abc) {
    await expect(o.page.locator(`${site.seat}[data-occupied="true"]`)).toHaveCount(3);
    for (const [i, m] of abc.entries()) if (o !== m) await expect(seat(o.page, i)).toHaveAttribute("aria-label", `Seat ${String(i + 1)}, taken by smoke-${m.name}`);
  }
  // A late click on a taken seat must not steal it.
  await seat(by("C").page, 0).click();
  await expect(seat(by("B").page, 0)).toHaveAttribute("aria-label", "Seat 1, taken by smoke-A");
  await shot(by("B").page, "movie-night-2-sit");
  record("movie-night-2", { seenMs: seen });
  for (const ms of Object.values(seen).flat()) expect.soft(ms).toBeLessThanOrEqual(SYNC_MS);
});

test.fixme("row 3 · react: B and C burst reactions; glyphs everywhere, throttled, not in the chat log (OME-1631, OME-1632)", pending);

test("row 4 · late join: D joins and sees the room", async () => {
  const d = await join("D");
  await expect(d.page.locator(site.nicknameTag)).toHaveCount(4, { timeout: 10_000 });
  await expect(d.page.locator(`${site.seat}[data-occupied="true"]`)).toHaveCount(3);
});

test.fixme("row 4b · late-join replay: D's moments strip shows row 3's reactions in order, within 2 s (OME-1628)", pending);

test.fixme("row 5 · countdown: A's shared 3-2-1 shows in step on every context, playback starts together (OME-1634)", pending);

test.fixme("row 6 · share at a time: extension 'start where I am' + one-click share; rooms list watchingCount/nowPlaying (OME-1636, OME-1633, OME-1635)", pending);

test("row 7 · play / pause / seek: every context follows A within 500 ms", async () => {
  const a = by("A");
  const res = await fetch(`${API}/rooms/${roomId}/share`, {
    method: "POST",
    headers: { authorization: `Bearer ${await shareToken(a.page)}`, origin: WEB, "content-type": "application/json" },
    body: JSON.stringify({ url: embedUrl(BASELINE_ID) }),
  });
  expect(res.status, "share").toBe(200);
  const all = members.map((m) => m.page);
  const frames = await Promise.all(all.map((p) => ytFrame(p, BASELINE_ID, 30_000)));
  await Promise.all(frames.map((f) => waitVideoPlaying(f, 60_000)));
  const [fa, ...others] = frames;
  if (fa === undefined) throw new Error("no frame on A");
  await a.page.waitForTimeout(3_000);
  const steady = await Promise.all(others.map((f) => spreadOver(fa, f, 6, 500)));

  const playKey = a.page.locator(site.playToggle);
  const pause = await followMs(() => playKey.click(), frames, (s) => s.paused);
  const play = await followMs(() => playKey.click(), frames, (s) => !s.paused);
  const fwd = await followMs(() => seekTo(a.page, 240), frames, (s) => Math.abs(s.currentTime - 240) < 2);
  const back = await followMs(() => seekTo(a.page, 60), frames, (s) => Math.abs(s.currentTime - 60) < 2);
  await a.page.waitForTimeout(3_000);
  const after = await Promise.all(others.map((f) => spreadOver(fa, f, 6, 500)));
  await Promise.all(members.map((m) => shot(m.page, `movie-night-7-${m.name}`)));
  // Behind A's own player: A's click → paused alone is YouTube's latency (~800 ms on a laptop), not the room's.
  const behindA = (ms: readonly number[]): number[] => ms.slice(1).map((t) => t - (ms[0] ?? Number.NaN));
  const lagMs = { pause: behindA(pause), play: behindA(play), fwd: behindA(fwd), back: behindA(back) };
  const result = { followMs: { pause, play, fwd, back }, lagMs, steadyMaxMs: steady.map((s) => s.maxAbsMs), afterMaxMs: after.map((s) => s.maxAbsMs) };
  record("movie-night-7", result);
  for (const ms of Object.values(lagMs).flat()) expect.soft(ms).toBeLessThanOrEqual(SYNC_MS);
  for (const ms of [...result.steadyMaxMs, ...result.afterMaxMs]) expect.soft(ms).toBeLessThanOrEqual(SYNC_MS);
});

test.fixme("row 7b · row 7 again right after a reaction burst (OME-1631)", pending);

test.fixme("row 8 · recap: the recap card shows the same numbers on every context at the video's end (OME-1629)", pending);

test("row 9 · reload: B reloads mid-video and is back in its seat, on the same video and position", async () => {
  const b = by("B");
  await b.page.reload();
  await enter(b.page, "smoke-B");
  await expect(seat(by("A").page, 1)).toHaveAttribute("aria-label", "Seat 2, taken by smoke-B", { timeout: 10_000 });
  const [fa, fb] = await Promise.all([ytFrame(by("A").page, BASELINE_ID), ytFrame(b.page, BASELINE_ID, 30_000)]);
  await waitVideoPlaying(fb, 60_000);
  await b.page.waitForTimeout(3_000);
  const spread = await spreadOver(fa, fb, 6, 500);
  await shot(b.page, "movie-night-9-reload");
  record("movie-night-9", { spread });
  expect.soft(spread.maxAbsMs).toBeLessThanOrEqual(SYNC_MS);
});

test("console: no site errors on any context", () => {
  expect(Object.fromEntries(members.map((m) => [m.name, m.consoleErrors]))).toEqual({ A: [], B: [], C: [], D: [] });
});
