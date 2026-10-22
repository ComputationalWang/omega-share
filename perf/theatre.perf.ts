// OME-1643 (Movie night Q1): the frame budgets in the theatre layout on a Pixel-class phone (devices["Pixel 7"], the
// phone watch layout), per provider playing (YouTube, Twitch VOD, Twitch live, Vimeo, a loaded generic embed). 8 clients
// (8 avatars), all seated facing the screen; the observer is the phone, with the room window and the chat log on screen.
// Every client is shown the theatre preset (show-layout.ts): `assets/presets/theatre.json` once OME-1630 lands it, main's
// `cinema.json` until then, `OMEGA_PERF_THEATRE_LAYOUT=<preset id>` another. The 7 others chat at the rate limit (a
// burst of CHAT_BURST each, then 1/s), FRAME_WINDOWS windows per provider as in chat.perf.ts (OME-846).
// Rows: theatre.frameP95.<p> (quantised p95 ≤ one vsync), theatre.workP95.<p> (≤ 8 ms), theatre.missedVsync.<p> (≤ 1 %).
import { existsSync } from "node:fs";
import { devices, expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { PENDING, available } from "../e2e/support/apps";
import { rawSnapshot } from "../e2e/support/bots";
import { EMBED_URL } from "../e2e/support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { FRAME_PROVIDERS, type FrameProvider } from "./budgets";
import { FRAME_WINDOWS, VSYNC_MS, tracedFrames, type FrameWindow } from "./frames";
import { recordMetric } from "./metrics";
import { GENERIC_HOST, GENERIC_PAGE, PROVIDER_CASES, waitProviderPlaying } from "./providers";
import { presetFile, showLayout } from "./show-layout";
import { summarizeWindows } from "./spread";
import { waitPlaying } from "./sync";

const CLIENTS = 8;
const WINDOW_MS = 5000;
/** The server's chat bucket: a burst of 5, then 1 a second. */
const CHAT_BURST = 5;
const CHAT_EVERY_MS = 1000;
const REFILL_MS = (CHAT_BURST + 1) * CHAT_EVERY_MS;
const PHONE = devices["Pixel 7"];
const PRESET = process.env["OMEGA_PERF_THEATRE_LAYOUT"] ?? (existsSync(new URL("../assets/presets/theatre.json", import.meta.url)) ? "theatre" : "cinema");
const LAYOUT = presetFile(PRESET);

const ids = (p: FrameProvider): string[] => [`theatre.frameP95.${p}`, `theatre.workP95.${p}`, `theatre.missedVsync.${p}`];

/** Share `url` as the room's current item; the per-room share bucket's 429s are waited out. */
async function share(request: APIRequestContext, roomId: string, url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const member = await joinForToken(roomId, "theatre-perf-sharer");
        try {
          return (await postShare(request, roomId, member.token, url)).status();
        } finally {
          member.close();
        }
      },
      { timeout: 60_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBe(200);
}

/** Each sender: a burst of CHAT_BURST, then one a second until the window ends. Returns how many went out. */
async function burst(senders: readonly Client[], tag: string): Promise<number> {
  const counts = await Promise.all(
    senders.map(async (c) => {
      const input = c.page.locator(site.chatInput);
      const say = async (i: number): Promise<void> => {
        await input.fill(`${tag} ${c.nickname} ${String(i)}`);
        await input.press("Enter");
      };
      let n = 0;
      const start = Date.now();
      while (n < CHAT_BURST) await say(n++);
      for (let at = CHAT_EVERY_MS; at < WINDOW_MS; at += CHAT_EVERY_MS) {
        const wait = start + at - Date.now();
        if (wait > 0) await c.page.waitForTimeout(wait);
        await say(n++);
      }
      return n;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

function record(p: FrameProvider, ws: readonly FrameWindow[], what: string): { p95: number; missedPct: number; workP95: number } {
  const f = summarizeWindows(ws, VSYNC_MS);
  recordMetric({ id: `theatre.frameP95.${p}`, value: f.p95, note: `${f.note}; ${what}` });
  recordMetric({ id: `theatre.workP95.${p}`, value: f.workP95, note: `${f.workNote}; ${what}` });
  recordMetric({ id: `theatre.missedVsync.${p}`, value: f.missedPct, note: `${f.missedNote}; ${what}` });
  return { p95: f.p95, missedPct: f.missedPct, workP95: f.workP95 };
}

test("theatre: frames per provider in the theatre layout on a phone, all 8 seated, chat burst at the rate limit", async ({ browser, request }) => {
  const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
  if (why !== null) {
    for (const p of FRAME_PROVIDERS) for (const id of ids(p)) recordMetric({ id, pending: why });
    test.skip(true, why);
    return;
  }
  test.setTimeout(720_000);
  const room = testRoom("theatre-perf", "frames");
  await share(request, room.id, EMBED_URL);
  const clients = await joinRoom(browser, {
    roomUrl: room.url,
    count: CLIENTS,
    nicknamePrefix: "th",
    // The observer (first) is the phone; the others are desktops.
    contextOptions: (i) => (i === 0 ? { ...PHONE } : undefined),
    setup: async (context) => {
      await showLayout(context, LAYOUT);
      await context.route(`https://${GENERIC_HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: GENERIC_PAGE }));
    },
  });
  const rows: Record<string, unknown> = {};
  try {
    const [observer, ...senders] = clients;
    if (observer === undefined) throw new Error("no observer");
    // Everyone takes a theatre seat, facing the screen.
    for (const [i, c] of clients.entries()) await c.page.locator(`${site.seat}[data-seat="${String(i)}"]`).click();
    await expect
      .poll(async () => {
        const snap: unknown = JSON.parse(await rawSnapshot(browser, room.id));
        const r: unknown = typeof snap === "object" && snap !== null ? Reflect.get(snap, "room") : null;
        const seats: unknown = typeof r === "object" && r !== null ? Reflect.get(r, "seats") : null;
        return Array.isArray(seats) ? seats.filter((s) => s !== null).length : 0;
      })
      .toBe(CLIENTS);
    const win = observer.page.locator(site.roomWindow);
    const lines = observer.page.locator(site.chatLogLine);
    const onScreen = async (): Promise<void> => {
      // The room window and the top of the chat log on screen together, so both are painted.
      await win.evaluate((el) => {
        el.scrollIntoView({ block: "start" });
      });
      await expect(win).toBeInViewport();
      await expect(observer.page.locator(site.chatLog)).toBeInViewport();
    };
    const measure = async (p: FrameProvider, label: string): Promise<void> => {
      await onScreen();
      const ws: FrameWindow[] = [];
      let sent = 0;
      for (let i = 0; i < FRAME_WINDOWS; i++) {
        // A full refill of every sender's chat bucket since the last window, so the burst is never refused.
        await observer.page.waitForTimeout(REFILL_MS);
        const [w, n] = await Promise.all([tracedFrames(browser, observer.page, WINDOW_MS), burst(senders, `${p}#${String(i)}`)]);
        await expect(lines.last()).toContainText(`${p}#${String(i)} `);
        expect(w.samples.length, `${p} window ${String(i)}`).toBeGreaterThan(0);
        ws.push(w);
        sent += n;
      }
      const each = `${String(sent)} chats from ${String(senders.length)} senders over ${String(FRAME_WINDOWS)} × ${String(WINDOW_MS)} ms windows`;
      rows[p] = { ...record(p, ws, `${label} playing, Pixel 7 emulation, ${PRESET} preset, ${String(CLIENTS)} avatars seated, ${each} (each window a burst of ${String(CHAT_BURST)}, then 1/s each)`), sent };
    };

    await waitPlaying(clients);
    await measure("youtube", "YouTube");
    for (const c of PROVIDER_CASES) {
      await share(request, room.id, c.shareUrl);
      await waitProviderPlaying(clients, c.provider);
      await measure(c.key, c.label);
    }
    await share(request, room.id, `https://${GENERIC_HOST}/embed/42`);
    // Click-to-load is per member, so only the observer loads it (OME-813, as chat.perf.ts).
    await observer.page.getByTestId("generic-load").click({ timeout: 15_000 });
    await expect(observer.page.frameLocator(site.sharedVideo).locator("div")).toBeVisible({ timeout: 15_000 });
    await measure("generic", "generic embed loaded");

    for (const [k, r] of Object.entries(rows)) {
      if (typeof r !== "object" || r === null) continue;
      expect(Reflect.get(r, "p95"), k).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
      expect(Reflect.get(r, "missedPct"), k).toBeLessThanOrEqual(1);
      expect(Reflect.get(r, "workP95"), k).toBeLessThanOrEqual(8);
    }
  } finally {
    await leaveAll(clients);
  }
});
