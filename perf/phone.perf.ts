// OME-596 (M7 W4): the frame budgets on a Pixel-class phone (Playwright mobile emulation, devices["Pixel 7"]: 412×915,
// DPR 2.625, touch) in the phone watch layout, per provider playing (YouTube, Twitch VOD, Twitch live, Vimeo, a loaded
// generic embed). 8 clients (8 avatars); the observer is the phone, with the room window and the chat log on screen.
// During the traced window the observer drags the room window sideways and back, and the 7 others chat at 1/s each.
// Rows: phone.frameP95.<p> (quantised p95 ≤ one vsync), phone.workP95.<p> (≤ 8 ms), phone.missedVsync.<p> (≤ 1 %).
import { devices, expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { PENDING, available } from "../e2e/support/apps";
import { EMBED_URL } from "../e2e/support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { FRAME_PROVIDERS, type FrameProvider } from "./budgets";
import { VSYNC_MS, tracedFrames, type FrameWindow } from "./frames";
import { p95, recordMetric } from "./metrics";
import { GENERIC_HOST, GENERIC_PAGE, PROVIDER_CASES, waitProviderPlaying } from "./providers";
import { summarizeFrames } from "./spread";
import { waitPlaying } from "./sync";

const CLIENTS = 8;
const WINDOW_MS = 5000;
const CHAT_EVERY_MS = 1000;
/** How far each drag moves the room window, and how many pointer moves it takes (one per frame or so). */
const DRAG_PX = 120;
const DRAG_STEPS = 24;
const MOVE_EVERY_MS = 16;
const PHONE = devices["Pixel 7"];

const ids = (p: FrameProvider): string[] => [`phone.frameP95.${p}`, `phone.workP95.${p}`, `phone.missedVsync.${p}`];

/** Share `url` as the room's current item; the per-room share bucket's 429s are waited out. */
async function share(request: APIRequestContext, roomId: string, url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const member = await joinForToken(roomId, "phone-perf-sharer");
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

/** One chat a second from each sender for the window (well inside ws.ts's bucket). Returns how many went out. */
async function chatter(senders: readonly Client[], tag: string): Promise<number> {
  const counts = await Promise.all(
    senders.map(async (c) => {
      const input = c.page.locator(site.chatInput);
      const start = Date.now();
      let n = 0;
      for (let at = 0; at < WINDOW_MS; at += CHAT_EVERY_MS) {
        const wait = start + at - Date.now();
        if (wait > 0) await c.page.waitForTimeout(wait);
        await input.fill(`${tag} ${c.nickname} ${String(n++)}`);
        await input.press("Enter");
      }
      return n;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

/** Drag the room window sideways and back, over and over, until the window ends. Returns how many drags. */
async function drag(page: Page): Promise<number> {
  const box = await page.locator(site.roomWindow).boundingBox();
  if (box === null) throw new Error("no room window");
  const x = box.x + box.width / 2;
  const y = box.y + 24;
  const end = Date.now() + WINDOW_MS - 500;
  let n = 0;
  while (Date.now() < end) {
    const dir = n % 2 === 0 ? -1 : 1;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // About one move a frame, like a finger (a touchscreen reports at the display's rate).
    for (let i = 1; i <= DRAG_STEPS; i++) {
      await page.mouse.move(x + (dir * DRAG_PX * i) / DRAG_STEPS, y);
      await page.waitForTimeout(MOVE_EVERY_MS);
    }
    await page.mouse.up();
    n++;
  }
  return n;
}

function record(p: FrameProvider, w: FrameWindow, what: string): { p95: number; missedPct: number; workP95: number } {
  const f = summarizeFrames(w.samples, VSYNC_MS);
  const workP95 = p95(w.workMs);
  recordMetric({ id: `phone.frameP95.${p}`, value: f.p95, note: `${f.note}; ${what}` });
  recordMetric({ id: `phone.workP95.${p}`, value: workP95, note: `${String(w.workMs.length)} traced frames, max ${Math.max(...w.workMs).toFixed(2)} ms; ${what}` });
  recordMetric({ id: `phone.missedVsync.${p}`, value: f.missedPct, note: `${String(f.missed)} of ${String(f.frames)} frames; ${what}` });
  return { p95: f.p95, missedPct: f.missedPct, workP95 };
}

test("phone: frames per provider on a Pixel-class phone in the watch layout (8 avatars + video, room dragged, chat at 1/s)", async ({ browser, request }) => {
  const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
  if (why !== null) {
    for (const p of FRAME_PROVIDERS) for (const id of ids(p)) recordMetric({ id, pending: why });
    test.skip(true, why);
    return;
  }
  test.setTimeout(420_000);
  const room = testRoom("phone-perf", "frames");
  await share(request, room.id, EMBED_URL);
  const clients = await joinRoom(browser, {
    roomUrl: room.url,
    count: CLIENTS,
    nicknamePrefix: "pp",
    // The observer (first) is the phone; the others are desktops.
    contextOptions: (i) => (i === 0 ? { ...PHONE } : undefined),
    setup: async (context) => {
      await context.route(`https://${GENERIC_HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: GENERIC_PAGE }));
    },
  });
  const rows: Record<string, unknown> = {};
  try {
    const [observer, ...senders] = clients;
    if (observer === undefined) throw new Error("no observer");
    const win = observer.page.locator(site.roomWindow);
    const lines = observer.page.locator(site.chatLogLine);
    const measure = async (p: FrameProvider, label: string): Promise<void> => {
      // The room window and the top of the chat log on screen together, so both are painted.
      await win.evaluate((el) => {
        el.scrollIntoView({ block: "start" });
      });
      await expect(win).toBeInViewport();
      await expect(observer.page.locator(site.chatLog)).toBeInViewport();
      await observer.page.waitForTimeout(CHAT_EVERY_MS);
      const [w, sent, drags] = await Promise.all([tracedFrames(browser, observer.page, WINDOW_MS), chatter(senders, p), drag(observer.page)]);
      await expect(lines.last()).toContainText(`${p} `);
      rows[p] = { ...record(p, w, `${label} playing, Pixel 7 emulation, ${String(CLIENTS)} avatars, ${String(drags)} drags of ${String(DRAG_PX)} px, ${String(sent)} chats in ${String(WINDOW_MS)} ms`), sent, drags };
    };

    await waitPlaying(clients);
    await measure("youtube", "YouTube");
    for (const c of PROVIDER_CASES) {
      await share(request, room.id, c.shareUrl);
      await waitProviderPlaying(clients, c.provider);
      await measure(c.key, c.label);
    }
    await share(request, room.id, `https://${GENERIC_HOST}/embed/42`);
    for (const c of clients) {
      await c.page.getByTestId("generic-load").click({ timeout: 15_000 });
      await expect(c.page.frameLocator(site.sharedVideo).locator("div")).toBeVisible({ timeout: 15_000 });
    }
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
