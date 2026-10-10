// OME-769 (M9 W3): "Hide for me", on the real page against the real server. The list's words, labels and announcements,
// the intake filter and the stored set are unit tests (apps/web/test/{people,hidden-members,room-events,chat-log}.test.ts);
// this spec checks what only two real browsers can: nothing goes out when you hide someone, their chat, bubbles and emotes
// stop on your page only, their avatar stays (dimmed), the report key stays, a reload in the same tab keeps it, and Show
// brings them back.
import type { Page } from "@playwright/test";
import * as v from "valibot";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Calls `window.__omega.room[name](...args)` (apps/web/src/main.ts, dev only). */
async function handle(page: Page, name: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ([n, a]) => {
      const debug: unknown = Reflect.get(window, "__omega");
      const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
      const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, n) : null;
      return typeof f === "function" ? (Reflect.apply(f, room, a) as unknown) : null;
    },
    [name, args] as const,
  );
}

const State = v.object({
  self: v.string(),
  bubbles: v.array(v.object({ memberId: v.string(), text: v.string() })),
  room: v.object({ members: v.array(v.object({ id: v.string(), nickname: v.string() })) }),
});
const state = async (page: Page): Promise<v.InferOutput<typeof State>> => v.parse(State, await handle(page, "state"));
const idOf = async (page: Page, nickname: string): Promise<string> => {
  const m = (await state(page)).room.members.find((x) => x.nickname === nickname);
  if (m === undefined) throw new Error(`no ${nickname}`);
  return m.id;
};
const alpha = async (page: Page, id: string): Promise<number> => v.parse(v.number(), await handle(page, "avatarAlpha", id));
const sticker = async (page: Page, id: string): Promise<string | null> => {
  const f = v.parse(v.nullish(v.object({ sticker: v.nullable(v.string()) })), await handle(page, "avatarFrames", id));
  return f?.sticker ?? null;
};

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatSend).click();
}

test("hide for me: nothing is sent, their chat, bubbles and emotes stop for me only, the avatar stays dimmed, Show undoes it", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("m9-hide", "main").url, count: 2, nicknamePrefix: "hd" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  await expect(a.page.locator(site.nicknameTag)).toHaveCount(2);
  await expect(b.page.locator(site.nicknameTag)).toHaveCount(2);
  const bId = await idOf(a.page, b.nickname);
  const aId = await idOf(b.page, a.nickname);
  const sent: string[] = [];
  a.page.on("websocket", (ws) => ws.on("framesent", (f) => {
    if (typeof f.payload === "string") sent.push(f.payload);
  }));

  // A opens People and hides B: a real button that names B; the row says "hidden"; the status says so.
  await a.page.locator(site.peopleKey).click();
  const row = a.page.locator(site.peopleRow).filter({ hasText: b.nickname });
  await row.getByRole("button", { name: `Hide ${b.nickname} for me` }).click();
  await expect(row).toContainText("hidden");
  await expect(a.page.locator(site.peopleStatus)).toHaveText(`${b.nickname} is hidden for you. Only you see this.`);
  await expect.poll(() => alpha(a.page, bId)).toBeLessThan(1);
  await expect(a.page.locator(site.nicknameTag).filter({ hasText: b.nickname })).toHaveClass(/is-hidden/);

  // B talks and emotes. B's own page shows it; A's log, live regions, bubbles and B's sticker show nothing.
  await say(b.page, "boo from b");
  await handle(b.page, "send", { type: "emote", kind: "wave" });
  await expect(b.page.locator(site.chatLog)).toContainText("boo from b");
  await say(a.page, "hi from a");
  await expect(b.page.locator(site.chatLog)).toContainText("hi from a");
  await expect(a.page.locator(site.chatLog)).toContainText("hi from a");
  await expect(a.page.locator(site.chatLog)).not.toContainText("boo from b");
  expect(await a.page.locator("[aria-live], [role=log], [role=status]").evaluateAll((els) => els.some((e) => e.textContent.includes("boo from b")))).toBe(false);
  expect((await state(a.page)).bubbles.filter((x) => x.memberId === bId)).toEqual([]);
  expect(await sticker(a.page, bId)).toBeNull();
  // B's avatar is still in A's room.
  expect(await alpha(a.page, bId)).toBeGreaterThan(0);

  // Never sent, never visible to others: A sent nothing but its clock pings and its own chat; B's page knows nothing.
  const types = sent.map((f) => v.parse(v.object({ type: v.string() }), JSON.parse(f)).type);
  expect(types.filter((t) => t !== "ping" && t !== "chat")).toEqual([]);
  expect(sent.some((f) => f.includes(bId))).toBe(false);
  await b.page.locator(site.peopleKey).click();
  await expect(b.page.locator(site.peopleRow).filter({ hasText: a.nickname })).not.toContainText("hidden");
  expect(await alpha(b.page, aId)).toBe(1);

  // Reporting is untouched: the report key is there and opens its dialog.
  await expect(a.page.locator(site.reportKey)).toBeVisible();
  await a.page.locator(site.reportKey).click();
  await expect(a.page.locator(site.reportDialog)).toBeVisible();
  await a.page.keyboard.press("Escape");

  // A reload in the same tab (a reconnect) keeps it.
  await a.page.reload();
  await a.page.locator(site.joinButton).click();
  await expect(a.page.locator(site.nicknameTag)).toHaveCount(2);
  await a.page.locator(site.peopleKey).click();
  await expect(a.page.locator(site.peopleRow).filter({ hasText: b.nickname })).toContainText("hidden");
  await say(b.page, "still hidden");
  await say(a.page, "after reload");
  await expect(a.page.locator(site.chatLog)).toContainText("after reload");
  await expect(a.page.locator(site.chatLog)).not.toContainText("still hidden");

  // Show undoes it.
  await a.page.locator(site.peopleRow).filter({ hasText: b.nickname }).getByRole("button", { name: `Show ${b.nickname}` }).click();
  await expect(a.page.locator(site.peopleStatus)).toHaveText(`${b.nickname} is shown again.`);
  await expect.poll(() => alpha(a.page, bId)).toBe(1);
  await say(b.page, "back again");
  await expect(a.page.locator(site.chatLog)).toContainText("back again");
});

/** The key toggles the panel: open it only if it isn't. */
async function openPeople(page: Page): Promise<void> {
  if (!(await page.locator(site.peoplePanel).isVisible())) await page.locator(site.peopleKey).click();
  await expect(page.locator(site.peoplePanel)).toBeVisible();
}

/** Opens People on A's page and hides `nickname`. */
async function hideFor(page: Page, nickname: string): Promise<void> {
  await openPeople(page);
  await page.locator(site.peopleRow).filter({ hasText: nickname }).getByRole("button", { name: `Hide ${nickname} for me` }).click();
  await expect(page.locator(site.peopleRow).filter({ hasText: nickname })).toContainText("hidden");
}

/** Records the member of every `room-emote` any page of the context hears on a pop-out channel. */
function recordEmotes(): void {
  const Native = window.BroadcastChannel;
  Reflect.set(window, "__emotes", []);
  window.BroadcastChannel = class extends Native {
    constructor(name: string) {
      super(name);
      this.addEventListener("message", (ev: MessageEvent<unknown>) => {
        const d = ev.data;
        if (typeof d !== "object" || d === null || Reflect.get(d, "t") !== "room-emote") return;
        const list: unknown = Reflect.get(window, "__emotes");
        if (Array.isArray(list)) list.push(String(Reflect.get(d, "member")));
      });
    }
  };
}
const emotesSeen = async (page: Page): Promise<string[]> => v.parse(v.array(v.string()), await page.evaluate((): unknown => Reflect.get(window, "__emotes")));

async function threeIn(browser: Parameters<typeof joinRoom>[0], name: "popchat" | "poproom"): Promise<[Client, Client, Client]> {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("m9-hide", name).url,
    count: 3,
    nicknamePrefix: `hp${name}`,
    setup: async (context, i) => {
      if (i === 0) await context.addInitScript(recordEmotes);
    },
  });
  const [a, b, c] = clients;
  if (a === undefined || b === undefined || c === undefined) throw new Error("no clients");
  for (const x of clients) await expect(x.page.locator(site.nicknameTag)).toHaveCount(3);
  return [a, b, c];
}

test("pop-out chat: a hidden member's lines are gone from the window's backlog and live log; others stay; Show brings them back there too", async ({ browser }) => {
  const [a, b, c] = await threeIn(browser, "popchat");
  await say(b.page, "b early");
  await expect(a.page.locator(site.chatLog)).toContainText("b early");
  await hideFor(a.page, b.nickname);
  await expect(a.page.locator(site.chatLogLine).filter({ hasText: "b early" })).toBeHidden();
  const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.chatPopout).click()]);
  await pop.waitForLoadState();
  await expect(pop.locator(site.chatInput)).toBeVisible();
  // The backlog the window starts with has no B line.
  await say(c.page, "c live");
  await expect(pop.locator(site.chatLogLine).filter({ hasText: "c live" })).toHaveCount(1);
  await expect(pop.locator(site.chatLog)).not.toContainText("b early");
  await say(b.page, "b live");
  await handle(b.page, "send", { type: "emote", kind: "wave" });
  await say(c.page, "c after b");
  await say(pop, "a from window");
  await expect(pop.locator(site.chatLogLine).filter({ hasText: "a from window" })).toHaveCount(1);
  await expect(pop.locator(site.chatLogLine).filter({ hasText: "c after b" })).toHaveCount(1);
  await expect(pop.locator(site.chatLog)).not.toContainText("b live");
  await expect(pop.locator(site.chatLog)).not.toContainText(b.nickname);
  // The live regions in the window say nothing of B either.
  expect(await pop.locator("[aria-live], [role=log], [role=status]").evaluateAll((els) => els.some((e) => e.textContent.includes("b live")))).toBe(false);

  // Show, from the room tab's People: the window gets the log back with B's earlier line, and B's new ones flow.
  await openPeople(a.page);
  await a.page.locator(site.peopleRow).filter({ hasText: b.nickname }).getByRole("button", { name: `Show ${b.nickname}` }).click();
  await expect(a.page.locator(site.peopleStatus)).toHaveText(`${b.nickname} is shown again.`);
  await expect(pop.locator(site.chatLog)).toContainText("b early");
  // What B said while hidden was dropped at intake (room-events.ts), so only what was already in the log returns.
  await expect(pop.locator(site.chatLog)).not.toContainText("b live");
  await say(b.page, "b back");
  await expect(pop.locator(site.chatLogLine).filter({ hasText: "b back" })).toHaveCount(1);
});

test("pop-out room: a hidden member's lines, bubbles and emotes never reach the window; another member's do", async ({ browser }) => {
  const [a, b, c] = await threeIn(browser, "poproom");
  const bId = await idOf(a.page, b.nickname);
  const cId = await idOf(a.page, c.nickname);
  await say(b.page, "b early");
  await expect(a.page.locator(site.chatLog)).toContainText("b early");
  await hideFor(a.page, b.nickname);
  const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.roomPopout).click()]);
  await pop.waitForLoadState();
  await expect(pop.locator(`${site.poproomRoom} canvas`)).toBeVisible();
  await expect(pop.locator(site.chatInput)).toBeEnabled();

  await say(b.page, "b live");
  await handle(b.page, "send", { type: "emote", kind: "wave" });
  await say(c.page, "c live");
  await handle(c.page, "send", { type: "emote", kind: "wave" });
  const log = pop.locator(site.poproomChat);
  await expect(log.locator(site.chatLogLine).filter({ hasText: "c live" })).toHaveCount(1);
  await expect(pop.locator(site.chatMessage).filter({ hasText: "c live" })).toHaveCount(1);
  await expect.poll(() => emotesSeen(pop).then((l) => l.includes(cId))).toBe(true);
  // B's things were sent before C's, over the same server: if they were coming they'd be here by now.
  await expect(log).not.toContainText("b early");
  await expect(log).not.toContainText("b live");
  await expect(pop.locator(site.chatMessage).filter({ hasText: "b live" })).toHaveCount(0);
  expect(await emotesSeen(pop)).not.toContain(bId);
  await expect(pop.locator(site.nicknameTag).filter({ hasText: b.nickname })).toHaveCount(1);
});

test("hide for me survives a real reconnect: still hidden, and the new socket sends no hide frame", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("m9-hide", "reconn").url,
    count: 2,
    nicknamePrefix: "hr",
    setup: async (context, i) => {
      // Keep every room socket the page opens, so the test can drop the live one without a reload.
      if (i === 0)
        await context.addInitScript(() => {
          const Native = window.WebSocket;
          Reflect.set(window, "__rsocks", []);
          window.WebSocket = class extends Native {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols);
              if (/\/rooms\/[^/]+\/ws$/.test(new URL(url, location.href).pathname)) {
                const list: unknown = Reflect.get(window, "__rsocks");
                if (Array.isArray(list)) list.push(this);
              }
            }
          };
        });
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  await expect(a.page.locator(site.nicknameTag)).toHaveCount(2);
  const bId = await idOf(a.page, b.nickname);
  // Sockets opened from here on: the reconnect's. Their sent frames are what we audit.
  const sockets: string[][] = [];
  a.page.on("websocket", (ws) => {
    const frames: string[] = [];
    sockets.push(frames);
    ws.on("framesent", (f) => {
      if (typeof f.payload === "string") frames.push(f.payload);
    });
  });
  await hideFor(a.page, b.nickname);
  await expect.poll(() => alpha(a.page, bId)).toBeLessThan(1);

  // Drop the live socket without a reload (a close code of its own reads as a network drop to the client).
  await a.page.evaluate(() => {
    const list: unknown = Reflect.get(window, "__rsocks");
    const live: unknown = Array.isArray(list) ? list.at(-1) : null;
    if (live instanceof WebSocket) live.close(3000);
  });
  await expect.poll(() => sockets.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(a.page.locator(site.connectionStatus)).toHaveText("", { timeout: 30_000 });
  await expect(a.page.locator(site.nicknameTag)).toHaveCount(2, { timeout: 30_000 });

  // The new socket is live (A's own line reaches B), and B is still hidden on A.
  await say(a.page, "a after the drop");
  await expect(b.page.locator(site.chatLog)).toContainText("a after the drop");
  await say(b.page, "b after the drop");
  await handle(b.page, "send", { type: "emote", kind: "wave" });
  await say(a.page, "a last");
  await expect(a.page.locator(site.chatLog)).toContainText("a last");
  await expect(a.page.locator(site.chatLog)).not.toContainText("b after the drop");
  expect((await state(a.page)).bubbles.filter((x) => x.memberId === bId)).toEqual([]);
  expect(await sticker(a.page, bId)).toBeNull();
  await expect(a.page.locator(site.nicknameTag).filter({ hasText: b.nickname })).toHaveClass(/is-hidden/);
  expect(await alpha(a.page, bId)).toBeLessThan(1);
  await openPeople(a.page);
  await expect(a.page.locator(site.peopleRow).filter({ hasText: b.nickname })).toContainText("hidden");

  // Nothing about hiding went out on the reconnect: the join, clock pings and chat only, and B's id is in none of it.
  const all = sockets.flat();
  const types = all.map((f) => v.parse(v.object({ type: v.string() }), JSON.parse(f)).type);
  expect(types).toContain("join");
  expect(types.filter((t) => t !== "join" && t !== "ping" && t !== "chat")).toEqual([]);
  expect(all.some((f) => f.includes(bId))).toBe(false);
});

test("a right-click or long-press on someone's name tag opens People on their Hide for me button", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("m9-hide", "tag").url, count: 2, nicknamePrefix: "ht" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  await expect(a.page.locator(site.nicknameTag)).toHaveCount(2);
  await a.page.locator(site.nicknameTag).filter({ hasText: b.nickname }).dispatchEvent("contextmenu");
  await expect(a.page.locator(site.peoplePanel)).toBeVisible();
  await expect(a.page.getByRole("button", { name: `Hide ${b.nickname} for me` })).toBeFocused();
  // My own tag opens nothing.
  await a.page.keyboard.press("Escape");
  await expect(a.page.locator(site.peoplePanel)).toBeHidden();
  await a.page.locator(site.nicknameTag).filter({ hasText: a.nickname }).dispatchEvent("contextmenu");
  await expect(a.page.locator(site.peoplePanel)).toBeHidden();
});
