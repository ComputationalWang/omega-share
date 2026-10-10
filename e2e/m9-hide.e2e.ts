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
