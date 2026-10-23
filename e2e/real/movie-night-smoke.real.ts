// The Movie night hosted smoke (OME-1650): rows 1-9 of docs/ops/movie-night-deploy.md §4, four browser contexts A
// (owner), B, C and D (late), real YouTube, headed on Xvfb through `bun run e2e:real`. Never in CI.
//   hosted: OMEGA_SMOKE_ORIGIN="$PUBLIC_ORIGIN" bun run e2e:real -- movie-night-smoke
//   local:  bun run e2e:real -- movie-night-smoke   (the lane's own web + server)
// A creates a private cinema room from the home page (POST /rooms: 2 per client per 10 min) and deletes it at the end.
// Row order follows what each row needs, not its number: reactions need a playing video, so A shares it in row 3; row 6
// shares it again at ~1:30 from a fifth profile E with the extension (E leaves after); row 9 (reload, mid-video) runs
// before row 8 (recap, at the video's end). Row 10 (kill switch) needs a server restart: it stays a manual deploy step.
// Evidence (JSON + PNG per row): e2e/real/results/movie-night-*; copy them to docs/qa/movie-night-hosted/ for the deploy.
import { EMOTE_BURST, EMOTE_REFILL_MS, ROOM_SECRETS_STORAGE_KEY, SHARE_TOKEN_STORAGE_KEY, parseServerMessage } from "@omega/shared";
import type { Reaction } from "@omega/shared";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Frame, Page } from "@playwright/test";
import { expect, test, watchCsp } from "../support/csp";
import { URLS } from "../support/apps";
import { openDirectory } from "../support/directory";
import { popup, site } from "../support/selectors";
import { BASELINE_ID, embedUrl, extensionDir, profile, record, requireVirtualDisplay, sampleVideo, shot, spreadOver, waitVideoPlaying, watchAt, ytFrame } from "./real";

test.beforeAll(requireVirtualDisplay);
// Serial: each row builds on the last, and any failure skips the rows after it (`expect.soft` included). So timings go
// through `soft()`: a miss is annotated on its row and the `timings` test near the end fails them all together.
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const HOSTED = process.env["OMEGA_SMOKE_ORIGIN"]?.replace(/\/$/, "");
/** The site and the API: one origin when hosted; the lane's two local servers otherwise. */
const WEB = HOSTED ?? URLS.web;
const API = HOSTED ?? URLS.server;
const SYNC_MS = 500;
/** Row 3 and 7b: each reacting member presses a reaction key every 250 ms for 5 s, then stops. */
const BURST_MS = 5_000;
/** Row 6: where E's watch page is when E shares; the room must start there (± 2 s). */
const SHARE_AT = 90;

/** What a member's socket said, read off the wire (the client opts into relay `batch` frames: unwrapped here). */
interface Wire {
  /** `batch` on each `join` this page sent (one per connect). */
  readonly joinBatch: unknown[];
  batches: number;
  self: string;
  readonly reacted: Reaction[];
  rateLimited: number;
  /** The latest snapshot's `reactions` (the late-join replay). */
  snapshotReactions: Reaction[] | null;
}

interface Member {
  readonly name: "A" | "B" | "C" | "D";
  readonly context: BrowserContext;
  page: Page;
  readonly consoleErrors: string[];
  readonly wire: Wire;
}

let browser: Browser;
let roomId = "";
let roomUrl = "";
let ownerToken = "";
const members: Member[] = [];
/** Soft limits missed so far, `row · what: value > max` (OME-1792). */
const overBudget: string[] = [];

/** A soft limit: a miss is annotated on the running row and recorded for the `timings` test; the row carries on. */
function soft(value: number, max: number, what: string): void {
  if (value <= max) return;
  const miss = `${what}: ${String(value)} > ${String(max)}`;
  overBudget.push(`${test.info().title.split(" · ")[0] ?? ""} · ${miss}`);
  test.info().annotations.push({ type: "over budget", description: miss });
}
const by = (name: Member["name"]): Member => {
  const m = members.find((x) => x.name === name);
  if (m === undefined) throw new Error(`${name} hasn't joined`);
  return m;
};

async function newMember(name: Member["name"]): Promise<Member> {
  const context = await watchCsp(await browser.newContext());
  // Reaction glyphs show only on the Smooth motion tier (e2e/reactions.e2e.ts).
  await context.addInitScript(() => {
    localStorage.setItem("omega.motion", "smooth");
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const wire: Wire = { joinBatch: [], batches: 0, self: "", reacted: [], rateLimited: 0, snapshotReactions: null };
  page.on("websocket", (ws) => {
    ws.on("framesent", ({ payload }) => {
      const msg: unknown = typeof payload === "string" ? JSON.parse(payload) : null;
      if (typeof msg === "object" && msg !== null && "type" in msg && msg.type === "join") wire.joinBatch.push("batch" in msg ? msg.batch : undefined);
    });
    ws.on("framereceived", ({ payload }) => {
      const msg = typeof payload === "string" ? parseServerMessage(payload) : null;
      if (msg?.type === "batch") wire.batches++;
      for (const m of msg?.type === "batch" ? msg.msgs : msg ? [msg] : []) {
        if (m.type === "reacted") wire.reacted.push({ memberId: m.memberId, kind: m.kind, mediaMs: m.mediaMs });
        if (m.type === "error" && m.code === "rate_limited") wire.rateLimited++;
        if (m.type === "snapshot") [wire.self, wire.snapshotReactions] = [m.self, m.reactions ?? []];
      }
    });
  });
  // Only the site's own errors: the YouTube player logs its own noise.
  page.on("console", (msg) => {
    const url = msg.location().url;
    // The local Vite dev server has no favicon (the hosted site serves one).
    if (HOSTED === undefined && url === `${WEB}/favicon.ico`) return;
    if (msg.type() === "error" && url.startsWith(WEB)) consoleErrors.push(`${msg.text()} ${url}`);
  });
  const m = { name, context, page, consoleErrors, wire };
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

/** Counts, from now on, every reaction glyph shown on the page (a glyph lives 0.9 s: a poll alone could miss it). */
async function watchGlyphs(page: Page): Promise<void> {
  await page.evaluate(() => {
    let seen = 0;
    Reflect.set(window, "__glyphsSeen", () => seen);
    new MutationObserver((records) => {
      for (const r of records) if (r.target instanceof HTMLElement && r.target.classList.contains("reaction-glyph") && !r.target.hidden) seen++;
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.classList.contains("reaction-glyph") && !n.hidden) seen++;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  });
}

const glyphsSeen = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const f: unknown = Reflect.get(window, "__glyphsSeen");
    return typeof f === "function" ? Number(Reflect.apply(f, window, [])) : 0;
  });

/** Every reacting member presses Shift+1..4 (heart, laugh, wow, clap) every 250 ms for BURST_MS: 4 a second, over the limit. */
async function burst(reacting: readonly Member[]): Promise<Record<string, number>> {
  const pressed = await Promise.all(reacting.map(async (m) => {
    await m.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    let n = 0;
    for (const t0 = Date.now(); Date.now() - t0 < BURST_MS; n++) {
      await m.page.keyboard.press(`Shift+Digit${String((n % 4) + 1)}`);
      await m.page.waitForTimeout(250);
    }
    return [m.name, n] as const;
  }));
  return Object.fromEntries(pressed);
}

/** Reactions A received from each reacting member since `from` (A's own wire, every reaction relayed to the room). */
function reactedSince(from: number, reacting: readonly Member[]): Record<string, number> {
  const got = by("A").wire.reacted.slice(from);
  return Object.fromEntries(reacting.map((m) => [m.name, got.filter((r) => r.memberId === m.wire.self).length]));
}

/** The moments strip's pips, summed: how many reactions the page puts on the timeline. */
const pipTotal = (page: Page): Promise<number> =>
  page.locator(`${site.momentsStrip} [data-testid="moments-pip"]`).evaluateAll((els) => els.reduce((n, el) => n + Number(el.getAttribute("data-count")), 0));

const ytFrames = (): Promise<Frame[]> => Promise.all(members.map((m) => ytFrame(m.page, BASELINE_ID, 30_000)));

/** Row 7's measurement: A pauses, plays (a shared 3-2-1 from paused), seeks forward and back; every context follows. */
async function playPauseSeek(row: string): Promise<void> {
  const a = by("A");
  const frames = await ytFrames();
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
  await Promise.all(members.map((m) => shot(m.page, `movie-night-${row}-${m.name}`)));
  // Behind A's own player: A's click → paused alone is YouTube's latency (~800 ms on a laptop), not the room's.
  const behindA = (ms: readonly number[]): number[] => ms.slice(1).map((t) => t - (ms[0] ?? Number.NaN));
  const lagMs = { pause: behindA(pause), play: behindA(play), fwd: behindA(fwd), back: behindA(back) };
  const result = { followMs: { pause, play, fwd, back }, lagMs, steadyMaxMs: steady.map((s) => s.maxAbsMs), afterMaxMs: after.map((s) => s.maxAbsMs) };
  record(`movie-night-${row}`, result);
  for (const [step, ms] of Object.entries(lagMs)) for (const t of ms) soft(t, SYNC_MS, `${step} lag`);
  for (const ms of [...result.steadyMaxMs, ...result.afterMaxMs]) soft(ms, SYNC_MS, "drift");
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
  // The theatre preset (OME-1630): seats in rows facing the screen.
  await a.page.locator('[data-testid="preset-cinema"]').check();
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

test("row 1b · join.batch opt-in: every join asks for batching; relay frames arrive as `batch` (OME-1627)", async () => {
  const abc = [by("A"), by("B"), by("C")];
  for (const m of abc) expect(m.wire.joinBatch, `${m.name}'s joins`).toEqual([true]);
  // The server holds relays 8 ms: a lone one goes out alone. B and C chat at once until everyone has had a batch.
  for (let i = 0; i < 5 && abc.some((m) => m.wire.batches === 0); i++) {
    await Promise.all([by("B"), by("C")].map(async (m) => {
      await m.page.locator(site.chatInput).fill(`batch ${String(i)} from ${m.name}`);
      await m.page.locator(site.chatInput).press("Enter");
    }));
    await by("A").page.waitForTimeout(500);
  }
  record("movie-night-1b", Object.fromEntries(abc.map((m) => [m.name, { joinBatch: m.wire.joinBatch, batches: m.wire.batches }])));
  for (const m of abc) expect(m.wire.batches, `${m.name} received batch frames`).toBeGreaterThan(0);
});

test("row 2 · sit: A, B, C take seats; every context sees each within 500 ms; no seat is double-booked", async () => {
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
  for (const ms of Object.values(seen).flat()) soft(ms, SYNC_MS, "seat seen");
});

test("row 3 · react: B and C burst reactions; glyphs everywhere, throttled, not in the chat log (OME-1631, OME-1632)", async () => {
  // Reactions need a playing video: A shares it now (the old row 7 share).
  const a = by("A");
  const res = await fetch(`${API}/rooms/${roomId}/share`, {
    method: "POST",
    headers: { authorization: `Bearer ${await shareToken(a.page)}`, origin: WEB, "content-type": "application/json" },
    body: JSON.stringify({ url: embedUrl(BASELINE_ID) }),
  });
  expect(res.status, "share").toBe(200);
  const abc = [a, by("B"), by("C")];
  await Promise.all((await ytFrames()).map((f) => waitVideoPlaying(f, 60_000)));
  for (const m of abc) await expect(m.page.getByTestId("reaction-bar"), `${m.name}'s reaction bar`).toBeVisible();
  for (const m of abc) await watchGlyphs(m.page);
  const lines = await Promise.all(abc.map((m) => m.page.locator(site.chatLogLine).count()));
  const limited = abc.map((m) => m.wire.rateLimited);

  const from = a.wire.reacted.length;
  const reacting = [by("B"), by("C")];
  const pressed = await burst(reacting);
  await a.page.waitForTimeout(1_000);
  const got = reactedSince(from, reacting);
  const glyphs = Object.fromEntries(await Promise.all(abc.map(async (m) => [m.name, await glyphsSeen(m.page)] as const)));
  const rateLimited = Object.fromEntries(abc.map((m, i) => [m.name, m.wire.rateLimited - (limited[i] ?? 0)]));
  await shot(by("C").page, "movie-night-3-react");
  record("movie-night-3", { pressed, reacted: got, glyphs, rateLimited });

  // The limit: EMOTE_BURST at once, then one per EMOTE_REFILL_MS (+1 for the refill already under way).
  const most = EMOTE_BURST + Math.ceil(BURST_MS / EMOTE_REFILL_MS) + 1;
  for (const m of reacting) {
    expect(got[m.name], `${m.name}'s reactions reached the room`).toBeGreaterThanOrEqual(EMOTE_BURST);
    expect(got[m.name], `${m.name} throttled`).toBeLessThanOrEqual(most);
  }
  // The bar cools before the server would refuse: no rate_limited flood.
  for (const [name, n] of Object.entries(rateLimited)) soft(n, 1, `${name} rate-limited notices`);
  // Every context got the same reactions, in the same order.
  for (const m of abc) expect(m.wire.reacted.slice(from), `${m.name}'s reactions`).toEqual(a.wire.reacted.slice(from));
  for (const m of abc) expect(glyphs[m.name], `${m.name} showed glyphs`).toBeGreaterThan(0);
  for (const [i, m] of abc.entries()) await expect(m.page.locator(site.chatLogLine), `${m.name}'s chat log`).toHaveCount(lines[i] ?? -1);
});

let dJoinedAt = 0;

test("row 4 · late join: D joins and sees the room", async () => {
  const d = await join("D");
  dJoinedAt = Date.now();
  await expect(d.page.locator(site.nicknameTag)).toHaveCount(4, { timeout: 10_000 });
  await expect(d.page.locator(`${site.seat}[data-occupied="true"]`)).toHaveCount(3);
});

test("row 4b · late-join replay: D's moments strip shows row 3's reactions in order, within 2 s (OME-1628)", async () => {
  const d = by("D");
  const strip = d.page.locator(site.momentsStrip);
  await expect(strip).toBeVisible({ timeout: 20_000 });
  const stripMs = Date.now() - dJoinedAt;
  // The snapshot is the replay: exactly what A saw relayed, oldest first, server-stamped, nothing duplicated.
  const all = by("A").wire.reacted;
  expect(d.wire.snapshotReactions, "D's snapshot reactions").toEqual(all);
  const ms = (d.wire.snapshotReactions ?? []).map((r) => r.mediaMs);
  expect(ms, "in media order").toEqual([...ms].sort((x, y) => x - y));
  const pips = { A: await pipTotal(by("A").page), D: await pipTotal(d.page) };
  await shot(d.page, "movie-night-4b-moments");
  record("movie-night-4b", { reactions: all.length, stripMs, pips });
  expect(pips.D, "D's strip counts what A's does").toBe(pips.A);
  expect(pips.D).toBeGreaterThan(0);
  soft(stripMs, 2_000, "strip after joining (ms)");
});

test("row 5 · countdown: A's shared 3-2-1 shows in step on every context, playback starts together (OME-1634)", async () => {
  const a = by("A");
  const frames = await ytFrames();
  await Promise.all(frames.map((f) => waitVideoPlaying(f, 60_000)));
  const playKey = a.page.locator(site.playToggle);
  await followMs(() => playKey.click(), frames, (s) => s.paused);
  await a.page.waitForTimeout(1_000);
  // Armed before the click, rAF-polled per page: when each shows the overlay.
  const shown = members.map((m) => m.page.waitForFunction((sel) => document.querySelector(sel)?.checkVisibility() === true, site.countdown,
    { polling: "raf", timeout: 10_000 }).then(() => Date.now()));
  const start = await followMs(() => playKey.click(), frames, (s) => !s.paused);
  const shownAt = await Promise.all(shown);
  for (const m of members) await expect(m.page.locator(site.countdown), `${m.name}'s countdown ends`).toBeHidden({ timeout: 5_000 });
  await Promise.all(members.map((m) => shot(m.page, `movie-night-5-${m.name}`)));
  const shownSpreadMs = Math.max(...shownAt) - Math.min(...shownAt);
  const startLagMs = start.slice(1).map((t) => t - (start[0] ?? Number.NaN));
  record("movie-night-5", { shownSpreadMs, startMs: start, startLagMs });
  expect(start[0], "A starts after the 3-2-1").toBeGreaterThanOrEqual(2_500);
  soft(shownSpreadMs, SYNC_MS, "overlay spread");
  for (const ms of startLagMs) soft(ms, SYNC_MS, "start lag");
});

test("row 6 · share at a time: extension one-click share from ~1:30 starts the room there; rooms list watchingCount (OME-1636, OME-1633, OME-1635)", async () => {
  // E: a fifth profile with the extension, in the room (its tab holds the share token), watching the video on YouTube.
  const e = await profile(extensionDir(HOSTED === undefined ? [] : [`${HOSTED}/*`]), API);
  try {
    const room = await e.context.newPage();
    await room.goto(roomUrl);
    await enter(room, "smoke-E");
    const watch = await e.context.newPage();
    const pageAt = await watchAt(watch, `https://www.youtube.com/watch?v=${BASELINE_ID}`, SHARE_AT);
    const p = await e.openPopup(watch);
    await expect(p.page.locator(popup.roomSelect), "the room tab with a share token is preselected").toHaveValue(roomId);
    const startSeconds = Number(await p.page.locator(popup.embedItem).first().locator("input").getAttribute("data-start-seconds"));
    expect(startSeconds, "listed start: where E is").toBeGreaterThanOrEqual(SHARE_AT);
    expect(startSeconds).toBeLessThanOrEqual(SHARE_AT + 30);
    await p.page.locator(popup.shareButton).click();
    await expect(p.page.locator(popup.shareStatus)).toHaveAttribute("data-state", "ok");
    const sharedAt = Date.now();
    await shot(p.page, "movie-night-6-popup");

    // Every context plays from the shared time: the room clock, startSeconds at the share, ± 2 s.
    const offsets = await Promise.all(members.map(async (m) => {
      const f = await ytFrame(m.page, BASELINE_ID, 30_000);
      let first = Number.NaN;
      await expect.poll(async () => {
        const v = await sampleVideo(f);
        if (v === null || v.paused || v.ad) return Number.POSITIVE_INFINITY;
        const off = v.currentTime - (startSeconds + (v.t - sharedAt) / 1000);
        if (Number.isNaN(first)) first = off;
        return Math.abs(off);
      }, { timeout: 60_000, intervals: [250], message: `${m.name} plays from ${String(startSeconds)} s` }).toBeLessThanOrEqual(2);
      return [m.name, Math.round(first * 1000)] as const;
    }));
    await shot(by("A").page, "movie-night-6-room");

    // A private room is never listed (by design); every listed room carries watchingCount (ADR 0056).
    const list: unknown = await (await fetch(`${API}/rooms`, { headers: { origin: WEB } })).json();
    const rooms: unknown[] = typeof list === "object" && list !== null && "rooms" in list && Array.isArray(list.rooms) ? list.rooms : [];
    const listed = rooms.map((r) => (typeof r === "object" && r !== null ? { id: "id" in r ? r.id : null, watchingCount: "watchingCount" in r ? r.watchingCount : null } : null));
    const noCount = listed.filter((r) => typeof r?.watchingCount !== "number");
    record("movie-night-6", { pageAt, startSeconds, firstOffsetMs: Object.fromEntries(offsets), listed: listed.length, noCount });
    expect(listed.map((r) => r?.id), "the private room is not listed").not.toContain(roomId);
    expect(noCount, "every listed room has watchingCount").toEqual([]);
  } finally {
    await e.context.close();
  }
});

test("row 7 · play / pause / seek: every context follows A within 500 ms", async () => {
  await playPauseSeek("7");
});

test("row 7b · row 7 again right after a reaction burst (OME-1631)", async () => {
  const from = by("A").wire.reacted.length;
  const reacting = [by("B"), by("C")];
  const pressed = await burst(reacting);
  const got = reactedSince(from, reacting);
  record("movie-night-7b-burst", { pressed, reacted: got });
  for (const m of reacting) expect(got[m.name], `${m.name}'s reactions reached the room`).toBeGreaterThanOrEqual(EMOTE_BURST);
  await playPauseSeek("7b");
});

test("row 9 · reload: B reloads mid-video and is back in its seat, on the same video and position", async () => {
  const b = by("B");
  await b.page.reload();
  await enter(b.page, "smoke-B");
  await expect(seat(by("A").page, 1)).toHaveAttribute("aria-label", "Seat 2, taken by smoke-B", { timeout: 10_000 });
  const [fa, fb] = await Promise.all([ytFrame(by("A").page, BASELINE_ID), ytFrame(b.page, BASELINE_ID, 30_000)]);
  await waitVideoPlaying(fb, 60_000);
  await b.page.waitForTimeout(3_000);
  const spread = await spreadOver(fa, fb, 6, 500);
  // The reaction timeline survives the reload.
  await expect(b.page.locator(site.momentsStrip)).toBeVisible({ timeout: 20_000 });
  const pips = { A: await pipTotal(by("A").page), B: await pipTotal(b.page) };
  await shot(b.page, "movie-night-9-reload");
  record("movie-night-9", { spread, pips });
  expect(pips.B, "B's strip counts what A's does").toBe(pips.A);
  soft(spread.maxAbsMs, SYNC_MS, "drift after reload");
});

test("row 8 · recap: the recap card shows the same numbers on every context at the video's end (OME-1629)", async () => {
  const a = by("A");
  const frames = await ytFrames();
  const [fa] = frames;
  if (fa === undefined) throw new Error("no frame on A");
  const duration = await fa.evaluate(() => document.querySelector("video")?.duration ?? Number.NaN);
  expect(duration, "video duration").toBeGreaterThan(180);
  await seekTo(a.page, Math.floor(duration) - 6);
  const card = (m: Member) => m.page.locator(site.recapCard);
  for (const m of members) await expect(card(m), `${m.name}'s recap`).toBeVisible({ timeout: 30_000 });
  const read = (m: Member) => card(m).evaluate((el) => ({
    moments: [...el.querySelectorAll('[data-testid="recap-moment"]')].map((li) => li.textContent.trim()),
    counts: [...el.querySelectorAll(".recap-count")].map((c) => c.getAttribute("title")),
    watched: el.querySelector('[data-testid="recap-watched"]')?.textContent.trim() ?? "",
  }));
  const recaps = Object.fromEntries(await Promise.all(members.map(async (m) => [m.name, await read(m)] as const)));
  await Promise.all(members.map((m) => shot(m.page, `movie-night-8-${m.name}`)));
  record("movie-night-8", { duration, recaps });
  const numbers = (r: Awaited<ReturnType<typeof read>> | undefined) => ({ moments: r?.moments, counts: r?.counts });
  expect(numbers(recaps["A"]).moments?.length, "A's recap has moments").toBeGreaterThan(0);
  for (const m of members) expect(numbers(recaps[m.name]), `${m.name}'s recap numbers`).toEqual(numbers(recaps["A"]));
  for (const m of members) {
    await m.page.getByTestId("recap-close").click();
    await expect(card(m), `${m.name}'s recap dismissed`).toBeHidden();
  }
});

test("timings: every soft limit held (misses are annotated on their rows)", () => {
  expect(overBudget).toEqual([]);
});

test("console: no site errors on any context", () => {
  expect(Object.fromEntries(members.map((m) => [m.name, m.consoleErrors]))).toEqual({ A: [], B: [], C: [], D: [] });
});
