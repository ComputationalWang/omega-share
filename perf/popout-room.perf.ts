// OME-600 (M7 W3b, ADR 0035): the frame budgets of both windows with the room popped out and the room full (25 members).
// One site client (the observer) pops its room out into `room.html`; 24 raw-socket bots fill the room: six sit for
// good, one bot sits on and stands up from a probe seat every 100 ms (so someone is always walking), and each chats
// every 3 s (~8 chats/s room-wide, under M3 limits). The video plays throughout (fake player). The room tab shows the
// picture only, its Pixi renderer paused, and relays every change from dispatch; the window draws the room (the one
// renderer, 25 avatars) and the chat. Each window is traced on its own, same load. Rows: poproom.frameP95.<w> (quantised
// p95 ≤ one vsync), poproom.workP95.<w> (≤ 8 ms), poproom.missedVsync.<w> (≤ 1 %), for w = tab | window.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { MAX_ROOM_MEMBERS } from "@omega/shared";
import { PENDING, available } from "../e2e/support/apps";
import { startTraffic } from "../e2e/support/bots";
import { joinRoom, leaveAll, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { VSYNC_MS, tracedFrames } from "./frames";
import { p95, recordMetric } from "./metrics";
import { summarizeFrames } from "./spread";
import { shareVideo, waitPlaying } from "./sync";

const WINDOW_MS = 8000;
const BOTS = MAX_ROOM_MEMBERS - 1;
const WINDOWS = ["tab", "window"] as const;
type Which = (typeof WINDOWS)[number];

const ids = (w: Which): string[] => [`poproom.frameP95.${w}`, `poproom.workP95.${w}`, `poproom.missedVsync.${w}`];

test("pop-out room: both windows' frames with 25 members (video playing, chat ~8/s, a sit or stand every 100 ms)", async ({ browser, request }) => {
  const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
  if (why !== null) {
    for (const w of WINDOWS) for (const id of ids(w)) recordMetric({ id, pending: why });
    test.skip(true, why);
    return;
  }
  test.setTimeout(180_000);
  const room = testRoom("popout-room-perf", "frames");
  await shareVideo(request, room.id);
  const clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "prp" });
  const traffic = await startTraffic(browser, room.id, {
    bots: BOTS,
    nicknamePrefix: "prp-bot",
    fixedSeats: [0, 1, 2, 3, 4, 5],
    chatEveryMs: 3000,
    probe: { seat: 6, everyMs: 100 },
  });
  try {
    const [observer] = clients;
    if (observer === undefined) throw new Error("no observer");
    const page = observer.page;
    await waitPlaying(clients);
    const [pop] = await Promise.all([observer.context.waitForEvent("page"), page.locator(site.roomPopout).click()]);
    await pop.waitForLoadState();
    await expect(pop.locator(`${site.poproomRoom} canvas`)).toBeVisible();
    await expect(pop.locator(site.nicknameTag)).toHaveCount(MAX_ROOM_MEMBERS);
    await expect(page.locator(site.roomAway)).toBeVisible();
    // One renderer: the window's. The room tab has no canvas on screen.
    await expect(page.locator(`${site.room} canvas`)).toBeHidden();
    await pop.waitForTimeout(1000);
    const measure = async (w: Which, target: Page): Promise<{ p95: number; missedPct: number; workP95: number }> => {
      const t = await tracedFrames(browser, target, WINDOW_MS);
      const s = await traffic.stats();
      const f = summarizeFrames(t.samples, VSYNC_MS);
      const workP95 = p95(t.workMs);
      const what = `the ${w === "tab" ? "room tab (picture, renderer paused)" : "room window (the room + chat)"}, ${String(s.members)} members (8 seated), video playing (fake player), ${String(s.chats)} chats + ${String(s.seatChanges)} seat changes so far`;
      recordMetric({ id: `poproom.frameP95.${w}`, value: f.p95, note: `${f.note}; ${what}` });
      recordMetric({ id: `poproom.workP95.${w}`, value: workP95, note: `${String(t.workMs.length)} traced frames, max ${Math.max(...t.workMs).toFixed(2)} ms; ${what}` });
      recordMetric({ id: `poproom.missedVsync.${w}`, value: f.missedPct, note: `${String(f.missed)} of ${String(f.frames)} frames; ${what}` });
      expect(s.members).toBe(MAX_ROOM_MEMBERS);
      expect(s.errors).toEqual([]);
      return { p95: f.p95, missedPct: f.missedPct, workP95 };
    };
    const rows = { window: await measure("window", pop), tab: await measure("tab", page) };
    for (const [k, r] of Object.entries(rows)) {
      expect(r.p95, k).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
      expect(r.missedPct, k).toBeLessThanOrEqual(1);
      expect(r.workP95, k).toBeLessThanOrEqual(8);
    }
  } finally {
    await traffic.stop();
    await leaveAll(clients);
  }
});
