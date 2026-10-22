// OME-1643 (Movie night Q6): JS heap after 10 min in a playing room with the moments strip and the recap card
// (docs/perf-budgets.md, ≤ 150 MB after a forced GC). One site client watches while 7 raw-socket bots react at the
// reaction rate limit (EMOTE_BURST, then one a refill), and a new item is shared every ITEM_EVERY_MS, so the strip
// fills and is cleared per item and the recap card opens for each ended one; the client dismisses it with Esc. The
// note counts how often the strip and the card were on screen: 0 until OME-1628 / OME-1629 mount them.
// Only under `bun run perf --soak` (see soak.ts); otherwise the budget reports PENDING.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { EMOTE_BURST, EMOTE_REFILL_MS, REACTION_KINDS } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { socketUrl } from "../e2e/support/bots";
import { watchCsp } from "../e2e/support/csp";
import { EMBED_URL } from "../e2e/support/network";
import { joinRoom, leaveAll, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { recordMetric } from "./metrics";
import { PROVIDER_CASES } from "./providers";
import { heapAfterGcMb, soakPlan } from "./soak";
import { waitPlaying } from "./sync";

const ID = "site.heapMovieNight";
const REACTERS = 7;
/** Just over the refill, so jitter never lands a react on an empty bucket. */
const REACT_EVERY_MS = EMOTE_REFILL_MS + 20;
const ITEM_EVERY_MS = 2 * 60_000;
const ITEMS = [EMBED_URL, ...PROVIDER_CASES.map((c) => c.shareUrl)];

async function share(request: APIRequestContext, roomId: string, url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const member = await joinForToken(roomId, "heap-movie-sharer");
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

test("site: JS heap after 10 min with reactions, the moments strip and the recap card", async ({ browser, request }) => {
  const plan = soakPlan(process.env);
  if (!plan.run) {
    recordMetric({ id: ID, pending: plan.reason });
    return;
  }
  if (!available.web || !available.server) {
    recordMetric({ id: ID, pending: available.web ? PENDING.server : PENDING.web });
    return;
  }
  test.setTimeout(plan.durationMs + 180_000);
  const room = testRoom("heap-movie", "main");
  await share(request, room.id, EMBED_URL);
  const clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "heap-movie" });
  const botContext = await watchCsp(await browser.newContext());
  const bots = await botContext.newPage();
  await bots.goto(URLS.web);
  await bots.evaluate(
    async ({ url, n, burst, every, kinds }) => {
      let sent = 0;
      let reacted = 0;
      const socks = await Promise.all(
        Array.from(
          { length: n },
          (_, i) =>
            new Promise<WebSocket>((resolve, reject) => {
              const ws = new WebSocket(url);
              ws.addEventListener("open", () => {
                ws.send(JSON.stringify({ type: "join", nickname: `hm-bot-${String(i + 1)}`, avatar: i % 4 }));
              });
              ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
                if (typeof ev.data !== "string") return;
                if (ev.data.includes('"snapshot"')) resolve(ws);
                else if (i === 0 && ev.data.includes('"reacted"')) reacted++;
              });
              ws.addEventListener("close", () => {
                reject(new Error("closed before snapshot"));
              });
            }),
        ),
      );
      const react = (ws: WebSocket): void => {
        ws.send(JSON.stringify({ type: "react", kind: kinds[sent % kinds.length] }));
        sent++;
      };
      for (const ws of socks) for (let k = 0; k < burst; k++) react(ws);
      const timer = window.setInterval(() => {
        for (const ws of socks) react(ws);
      }, every);
      Object.assign(window, {
        omegaReacters: {
          stop: () => {
            clearInterval(timer);
            for (const ws of socks) ws.close();
            return { sent, reacted };
          },
        },
      });
    },
    { url: socketUrl(room.id), n: REACTERS, burst: EMOTE_BURST, every: REACT_EVERY_MS, kinds: [...REACTION_KINDS] },
  );
  try {
    const [client] = clients;
    if (!client) throw new Error("no site client");
    const { page } = client;
    await waitPlaying(clients);
    const startMb = await heapAfterGcMb(page);
    const end = Date.now() + plan.durationMs;
    let items = 1;
    let stripSeen = 0;
    let recapsDismissed = 0;
    let nextItem = Date.now() + ITEM_EVERY_MS;
    while (Date.now() < end) {
      if (Date.now() >= nextItem) {
        await share(request, room.id, ITEMS[items % ITEMS.length] ?? EMBED_URL);
        items++;
        nextItem = Date.now() + ITEM_EVERY_MS;
      }
      if (await page.locator(site.momentsStrip).isVisible()) stripSeen++;
      const recap = page.locator(site.recapCard);
      if (await recap.isVisible()) {
        await page.waitForTimeout(2000);
        await page.keyboard.press("Escape");
        await expect(recap).toBeHidden();
        recapsDismissed++;
      }
      await page.waitForTimeout(Math.min(5000, Math.max(0, end - Date.now())));
    }
    const endMb = await heapAfterGcMb(page);
    const r: unknown = await bots.evaluate((): unknown => {
      const t: unknown = Reflect.get(window, "omegaReacters");
      const stop: unknown = typeof t === "object" && t !== null ? Reflect.get(t, "stop") : null;
      return typeof stop === "function" ? Reflect.apply(stop, t, []) : null;
    });
    const sent = typeof r === "object" && r !== null ? Number(Reflect.get(r, "sent")) : 0;
    const reacted = typeof r === "object" && r !== null ? Number(Reflect.get(r, "reacted")) : 0;
    const minutes = (plan.durationMs / 60_000).toFixed(1);
    const detail = `${minutes} min: start ${startMb.toFixed(1)} MB → end ${endMb.toFixed(1)} MB; ${String(items)} items shared, ${String(REACTERS)} bots sent ${String(sent)} reactions (${String(reacted)} relayed${reacted === 0 ? ": none until OME-1632" : ""}); moments strip on screen in ${String(stripSeen)} checks, recap card dismissed ${String(recapsDismissed)}×${stripSeen === 0 && recapsDismissed === 0 ? " (neither mounted yet: OME-1628, OME-1629)" : ""}`;
    if (plan.full) recordMetric({ id: ID, value: endMb, note: detail });
    else recordMetric({ id: ID, pending: `short soak doesn't count: ${detail}` });
  } finally {
    await botContext.close();
    await leaveAll(clients);
  }
});
