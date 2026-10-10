// OME-602 (M7 Q1): pop-out channel spoofing. The room tab keeps the one WebSocket and talks to its `chat.html` /
// `room.html` window over a BroadcastChannel named `omega-chat:<room>:<tab>` (ADR 0034, apps/web/src/popout/channel.ts).
// Any same-origin page can open that channel, so every message is parsed (strict Valibot schema) on both ends and
// anything else is dropped. This spec posts garbage and forgeries onto the channel from a bare same-origin page that is
// NOT a legit window, and from other origins, and proves:
//   1. malformed messages on the real channel make the room tab send no WebSocket frame, put nothing in anyone's chat,
//      close or adopt nothing, raise no page error, and the legit window keeps working (one real message still goes
//      through, exactly once);
//   2. malformed messages toward the window leave its log, head count, title, form and plug alone, and well-formed
//      messages on another tab's / room's channel name reach neither end;
//   3. a page on a foreign origin (127.0.0.1 vs localhost, the fixtures port) opening the same channel name is not heard
//      at all (BroadcastChannel is origin-scoped); a same-origin control proves the probe does deliver;
//   4. a forged sender (extra member/nickname fields, a window id that isn't the adopted one) never speaks as someone
//      else: the one chat frame the server sees is `{type, text}` from our own socket;
//   5. the same for the whole-room window (`room.html`): forged pop-sit / stage messages are dropped.
// Out of scope by design: a same-origin page that has the channel name AND the adopted window's id (both can be
// eavesdropped from the channel) is trusted like the window itself; the channel is a same-origin boundary, not an
// authenticated one. Neither the window nor the room tab listens for `message` events (no `postMessage` surface), so
// there is nothing to spoof there. The rooms are the perf specs' seeded ones: nothing else in the e2e project uses them.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { clickClosing, joinRoom, leaveAll, testRoom, type Client, type TestRoom } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** What the room tab's context saw: every frame its room socket sent (text) and every page error / console error. */
interface Tap {
  readonly frames: string[];
  readonly errors: string[];
}
let tap: Tap = { frames: [], errors: [] };

const ROOM_WS = /\/rooms\/[^/]+\/ws$/;
const watch = (context: BrowserContext, into: Tap): void => {
  context.on("page", (p) => {
    p.on("pageerror", (e) => {
      into.errors.push(`pageerror: ${e.message}`);
    });
    p.on("console", (m) => {
      if (m.type() === "error") into.errors.push(`console: ${m.text()}`);
    });
    p.on("websocket", (ws) => {
      if (!ROOM_WS.test(new URL(ws.url()).pathname)) return;
      ws.on("framesent", (f) => {
        into.frames.push(typeof f.payload === "string" ? f.payload : f.payload.toString("utf8"));
      });
    });
  });
};

const frameType = (payload: string): string => {
  const parsed: unknown = JSON.parse(payload);
  const type: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "type") : null;
  return typeof type === "string" ? type : "?";
};
/** Frames the room tab sent since `from`, bar the clock pings it sends on its own. */
const actions = (from: number): string[] => tap.frames.slice(from).filter((f) => frameType(f) !== "ping");

async function join(browser: Browser, room: TestRoom, prefix: string): Promise<[Client, Client]> {
  tap = { frames: [], errors: [] };
  const mine = tap;
  clients = await joinRoom(browser, {
    roomUrl: room.url,
    count: 2,
    nicknamePrefix: prefix,
    setup: (context, i) => {
      if (i === 0) watch(context, mine);
      return Promise.resolve();
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  return [a, b];
}
const chatRoom = (): TestRoom => testRoom("m7-spoof", "chat");
const stageRoom = (): TestRoom => testRoom("m7-spoof", "stage");

async function popOut(a: Client): Promise<Page> {
  const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.chatPopout).click()]);
  await pop.waitForLoadState();
  await expect(pop.locator(site.chatInput)).toBeEnabled();
  await expect(a.page.locator(site.chatAway)).toBeVisible();
  return pop;
}
async function popRoom(a: Client): Promise<Page> {
  const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.roomPopout).click()]);
  await pop.waitForLoadState();
  await expect(pop.locator(`${site.poproomRoom} canvas`)).toBeVisible();
  await expect(pop.locator(site.chatInput)).toBeEnabled();
  await expect(a.page.locator(site.roomAway)).toBeVisible();
  return pop;
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

/** The window's room and tab, from its address (`#r=<room>&t=<tab>`). */
function channelOf(pop: Page): { room: string; tab: string; name: string } {
  const p = new URLSearchParams(new URL(pop.url()).hash.slice(1));
  const room = p.get("r");
  const tab = p.get("t");
  if (room === null || tab === null) throw new Error(`no channel in ${pop.url()}`);
  // Spelled out here, not imported: the name is part of the contract this spec pins.
  return { room, tab, name: `omega-chat:${room}:${tab}` };
}

/** A bare page on `origin` (its `/spoof` answered by a stub, so no app code runs there). */
async function spoofer(context: BrowserContext, origin: string): Promise<Page> {
  const page = await context.newPage();
  await page.route(`${origin}/spoof`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>spoof</title>" }));
  await page.goto(`${origin}/spoof`);
  return page;
}

/**
 * Control: a well-formed ready from `page` on the real channel is heard (the adopted window is told to go). Ends a
 * "nothing happened" test, so it can't pass because the probe page never delivered (review OME-712).
 */
async function provesDelivery(page: Page, name: string, pop: Page): Promise<void> {
  const closed = pop.waitForEvent("close");
  await post(page, [name], [{ t: "pop-ready", pop: "p-control" }]);
  await closed;
}

/** Posts every message on each named channel from `page` (one channel object each, closed after). `huge` adds big ones. */
async function post(page: Page, names: readonly string[], messages: readonly unknown[], huge = false): Promise<void> {
  await page.evaluate(
    ([chans, msgs, big]) => {
      const names = chans as string[];
      const list = msgs as unknown[];
      for (const name of names) {
        const ch = new BroadcastChannel(name);
        for (const m of list) ch.postMessage(m);
        if (big) {
          ch.postMessage({ t: "pop-say", pop: "p-0000", seq: 0, text: "x".repeat(4_000_000) });
          ch.postMessage("y".repeat(4_000_000));
          ch.postMessage(Array.from({ length: 200_000 }, (_, i) => ({ t: "room-back", i })));
          let deep: unknown = { t: "pop-bye" };
          for (let i = 0; i < 2000; i++) deep = { nest: deep };
          ch.postMessage(deep);
        }
        ch.close();
      }
    },
    [names, messages, huge] as const,
  );
}

const OTHER = "p-0000000000000000";
const long = (n: number): string => "x".repeat(n);

// What no window sends, on the real channel. None of these parses, so none may do anything (the well-formed ones are
// for another window's id: not the adopted one).
const NOT_OBJECTS: unknown[] = [null, undefined, 0, 42, -1, NaN, true, false, "", "pop-say", '{"t":"pop-say","pop":"p-1","seq":0,"text":"x"}', [], [1, 2, 3], ["pop-say"], [{ t: "pop-bye", pop: OTHER }]];
const UNKNOWN_TYPES: unknown[] = [
  {},
  { t: "nope" },
  { t: "" },
  { t: 1 },
  { t: null },
  { t: ["pop-say"] },
  { t: "pop-sudo", pop: OTHER },
  { t: "POP-SAY", pop: OTHER, seq: 0, text: "x" },
  { t: "__proto__" },
  { type: "chat", text: "wire-shaped, not channel-shaped" },
  { type: "sit", seat: 1 },
  { type: "emote", kind: "clap" },
  { type: "join", nickname: "mallory" },
];
const MISSING_FIELDS: unknown[] = [
  { t: "pop-ready" },
  { t: "pop-say" },
  { t: "pop-say", pop: OTHER },
  { t: "pop-say", pop: OTHER, seq: 0 },
  { t: "pop-say", pop: OTHER, text: "x" },
  { t: "pop-emote", pop: OTHER, seq: 0 },
  { t: "pop-sit", pop: OTHER },
  { t: "pop-back" },
  { t: "pop-bye" },
  { t: "pop-ping" },
  { t: "room-adopt" },
  { t: "room-state" },
  { t: "room-log" },
  { t: "room-said", pop: OTHER },
];
const EXTRA_FIELDS: unknown[] = [
  { t: "pop-ready", pop: OTHER, x: 1 },
  { t: "pop-ready", pop: OTHER, kind: "room", admin: true },
  { t: "pop-say", pop: OTHER, seq: 0, text: "x", member: "m-1", nickname: "b" },
  { t: "pop-emote", pop: OTHER, seq: 0, kind: "clap", member: "m-1" },
  { t: "pop-sit", pop: OTHER, seat: 1, member: "m-1" },
  { t: "pop-bye", pop: OTHER, x: 1 },
  { t: "room-hello", x: 1 },
  { t: "room-back", x: 1 },
  { t: "room-gone", x: 1 },
  { t: "room-adopt", pop: OTHER, x: 1 },
];
const BAD_VALUES: unknown[] = [
  { t: "pop-ready", pop: "bad id!" },
  { t: "pop-ready", pop: long(41) },
  { t: "pop-ready", pop: 7 },
  { t: "pop-ready", pop: OTHER, kind: "admin" },
  { t: "pop-say", pop: OTHER, seq: -1, text: "x" },
  { t: "pop-say", pop: OTHER, seq: 1.5, text: "x" },
  { t: "pop-say", pop: OTHER, seq: "1", text: "x" },
  { t: "pop-say", pop: OTHER, seq: Infinity, text: "x" },
  { t: "pop-say", pop: OTHER, seq: NaN, text: "x" },
  { t: "pop-say", pop: OTHER, seq: 0, text: 5 },
  { t: "pop-say", pop: "", seq: 0, text: "x" },
  { t: "pop-emote", pop: OTHER, seq: 0, kind: "boom" },
  { t: "pop-sit", pop: OTHER, seat: 99 },
  { t: "pop-sit", pop: OTHER, seat: -1 },
  { t: "pop-sit", pop: OTHER, seat: 1.5 },
  { t: "pop-bye", pop: "bad id!" },
  { t: "room-adopt", pop: 5 },
  { t: "room-adopt", pop: "bad id!" },
];
// Well-formed, but for a window that isn't the adopted one: the relay answers none of them.
const FOR_ANOTHER_WINDOW: unknown[] = [
  { t: "pop-say", pop: OTHER, seq: 0, text: "forged chat" },
  { t: "pop-say", pop: OTHER, seq: 1, text: "forged chat" },
  { t: "pop-emote", pop: OTHER, seq: 2, kind: "clap" },
  { t: "pop-sit", pop: OTHER, seat: 1 },
  { t: "pop-back", pop: OTHER },
  { t: "pop-bye", pop: OTHER },
  { t: "pop-ping", pop: OTHER },
];
// Longer than any chat (280) and than the channel's own cap (1000), under a window id that isn't the adopted one.
const OVERSIZED: unknown[] = [281, 1000, 1001, 5000].map((n) => ({ t: "pop-say", pop: OTHER, seq: 0, text: long(n) }));
const MALFORMED_TO_TAB: readonly unknown[] = [...NOT_OBJECTS, ...UNKNOWN_TYPES, ...MISSING_FIELDS, ...EXTRA_FIELDS, ...BAD_VALUES, ...FOR_ANOTHER_WINDOW, ...OVERSIZED];

/** Everything the window shows, for before/after. */
const snapshot = async (pop: Page): Promise<{ closed: boolean; title: string; people: string; lines: string[]; placeholder: string; plug: boolean; enabled: boolean }> => ({
  closed: pop.isClosed(),
  title: await pop.title(),
  people: await pop.locator(site.popoutPeople).innerText(),
  lines: await pop.locator(site.chatLogLine).allInnerTexts(),
  placeholder: (await pop.locator(site.chatInput).getAttribute("placeholder")) ?? "",
  plug: await pop.locator(site.popoutGone).isVisible(),
  enabled: await pop.locator(site.chatInput).isEnabled(),
});

test("malformed messages on the real channel: no frame, no chat, no close or adopt; the window still works once", async ({ browser }) => {
  const [a, b] = await join(browser, chatRoom(), "spfa");
  const pop = await popOut(a);
  const { name } = channelOf(pop);
  await say(b.page, "before");
  await expect(pop.locator(site.chatLogLine)).toHaveText(["spfa-2 before"]);
  const before = await snapshot(pop);
  const bLines = await b.page.locator(site.chatLogLine).allInnerTexts();
  const spoof = await spoofer(a.context, URLS.web);
  const mark = tap.frames.length;
  const errors = tap.errors.length;

  await post(spoof, [name], MALFORMED_TO_TAB, true);
  await a.page.waitForTimeout(700);

  expect(actions(mark)).toEqual([]);
  expect(await snapshot(pop)).toEqual(before);
  expect(await b.page.locator(site.chatLogLine).allInnerTexts()).toEqual(bLines);
  await expect(a.page.locator(site.chatAway)).toBeVisible();
  expect(pop.isClosed()).toBe(false);

  // The window is still adopted and still the only one: a real message goes through, once.
  await say(pop, "still me");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("spfa-1 still me");
  await b.page.waitForTimeout(300);
  await expect(b.page.locator(site.chatLogLine).filter({ hasText: "still me" })).toHaveCount(1);
  expect(actions(mark).map((f) => frameType(f))).toEqual(["chat"]);
  expect(tap.errors.slice(errors)).toEqual([]);
  await provesDelivery(spoof, name, pop);
});

test("well-formed forgeries on another tab's or another room's channel never reach the room tab or its window", async ({ browser }) => {
  const [a, b] = await join(browser, chatRoom(), "spfb");
  const pop = await popOut(a);
  const { room, tab } = channelOf(pop);
  await say(b.page, "before");
  await expect(pop.locator(site.chatLogLine)).toHaveText(["spfb-2 before"]);
  const before = await snapshot(pop);
  const bLines = await b.page.locator(site.chatLogLine).allInnerTexts();
  const spoof = await spoofer(a.context, URLS.web);
  const mark = tap.frames.length;
  const errors = tap.errors.length;

  const wellFormed: unknown[] = [
    { t: "room-hello" },
    { t: "pop-ready", pop: "p-forged" },
    { t: "pop-ready", pop: "p-forged", kind: "room" },
    { t: "pop-say", pop: "p-forged", seq: 0, text: "forged chat" },
    { t: "pop-emote", pop: "p-forged", seq: 1, kind: "clap" },
    { t: "pop-sit", pop: "p-forged", seat: 1 },
    { t: "pop-back", pop: "p-forged" },
    { t: "pop-bye", pop: "p-forged" },
    { t: "room-adopt", pop: "p-forged" },
    { t: "room-back" },
    { t: "room-gone" },
    { t: "room-log", reset: true, entries: [{ kind: "chat", nickname: "mallory", text: "forged log", self: false }] },
    { t: "room-state", title: "forged", people: 9, cap: 25, open: true, cooling: false, muted: false, placeholder: "forged" },
  ];
  // Another tab of this room (this very tab's id with one more character, or another), another room, and malformed names.
  await post(spoof, [`omega-chat:${room}:${tab}x`, `omega-chat:${room}:t-0000000000000000`, `omega-chat:e2e-other-room:${tab}`, `omega-chat:${room}`, `omega-chat:${tab}`, tab], wellFormed);
  await a.page.waitForTimeout(700);

  expect(actions(mark)).toEqual([]);
  expect(await snapshot(pop)).toEqual(before);
  expect(await b.page.locator(site.chatLogLine).allInnerTexts()).toEqual(bLines);
  await expect(a.page.locator(site.chatAway)).toBeVisible();
  await say(pop, "still me");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("spfb-1 still me");
  expect(tap.errors.slice(errors)).toEqual([]);
  await provesDelivery(spoof, channelOf(pop).name, pop);
});

test("malformed messages toward the window: its log, count, title, form and plug stay; it is not closed", async ({ browser }) => {
  const [a, b] = await join(browser, chatRoom(), "spfc");
  const pop = await popOut(a);
  const { name } = channelOf(pop);
  await say(b.page, "one");
  await say(b.page, "two");
  await expect(pop.locator(site.chatLogLine)).toHaveText(["spfc-2 one", "spfc-2 two"]);
  const before = await snapshot(pop);
  const spoof = await spoofer(a.context, URLS.web);
  const mark = tap.frames.length;
  const errors = tap.errors.length;
  const state = { title: "forged", people: 9, cap: 25, open: true, cooling: false, muted: false, placeholder: "forged" };
  const entry = { kind: "chat", nickname: "mallory", text: "forged log", self: false };

  const toWindow: unknown[] = [
    // The log: a reset that would wipe it, or a line that isn't one.
    { t: "room-log", reset: true, entries: [{ kind: "chat", nickname: "mallory", text: "forged log" }] },
    { t: "room-log", reset: true, entries: [{ ...entry, extra: 1 }] },
    { t: "room-log", reset: true, entries: [{ ...entry, kind: "system" }] },
    { t: "room-log", reset: false, entries: [{ ...entry, text: long(1001) }] },
    { t: "room-log", reset: true, entries: "nope" },
    { t: "room-log", reset: "yes", entries: [entry] },
    { t: "room-log", reset: true, entries: Array.from({ length: 51 }, () => entry) },
    { t: "room-log", reset: true, entries: [entry], extra: 1 },
    // The state: the count, the title, the field's text.
    { t: "room-state", ...state, people: -1 },
    { t: "room-state", ...state, people: 1.5 },
    { t: "room-state", ...state, title: 5 },
    { t: "room-state", ...state, placeholder: long(1001) },
    { t: "room-state", ...state, muted: "yes" },
    { t: "room-state", ...state, extra: 1 },
    { t: "room-state", title: "forged" },
    // The plug, the close, the adopt, the answer.
    { t: "room-gone", x: 1 },
    { t: "room-back", x: 1 },
    { t: "room-back", pop: OTHER },
    { t: "room-adopt" },
    { t: "room-adopt", pop: 5 },
    { t: "room-adopt", pop: "bad id!" },
    { t: "room-adopt", pop: OTHER, x: 1 },
    { t: "room-said", pop: OTHER, seq: "1", ok: true },
    { t: "room-said", pop: OTHER, seq: 1 },
    { t: "room-hello", x: 1 },
    { t: "room-raise", x: 1 },
    { t: "room-view", status: "open" },
    { t: "room-tv", video: "yes" },
    { t: "room-emote", member: 5, kind: "boom" },
    ...NOT_OBJECTS,
    ...UNKNOWN_TYPES,
  ];
  await post(spoof, [name], toWindow, true);
  await a.page.waitForTimeout(700);

  expect(await snapshot(pop)).toEqual(before);
  expect(actions(mark)).toEqual([]);
  await expect(a.page.locator(site.chatAway)).toBeVisible();
  // Alive both ways.
  await say(b.page, "three");
  await expect(pop.locator(site.chatLogLine).last()).toHaveText("spfc-2 three");
  await say(pop, "four");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("spfc-1 four");
  expect(tap.errors.slice(errors)).toEqual([]);
  await provesDelivery(spoof, name, pop);
});

test("a page on another origin opening the channel is not heard: no frame, no adopt, no close", async ({ browser }) => {
  const [a, b] = await join(browser, chatRoom(), "spfd");
  const pop = await popOut(a);
  const { name } = channelOf(pop);
  await say(b.page, "before");
  await expect(pop.locator(site.chatLogLine)).toHaveText(["spfd-2 before"]);
  const before = await snapshot(pop);
  const bLines = await b.page.locator(site.chatLogLine).allInnerTexts();
  const web = new URL(URLS.web);
  const origins = [`http://127.0.0.1:${web.port}`, URLS.fixtures, `http://localhost:${String(Number(web.port) + 1)}`];
  expect(origins.every((o) => new URL(o).origin !== web.origin)).toBe(true);
  const mark = tap.frames.length;
  const errors = tap.errors.length;

  // What a window would send, and what the room tab would send it: all well-formed, including the ones that adopt and close.
  const wellFormed: unknown[] = [
    { t: "pop-ready", pop: "p-foreign" },
    { t: "pop-ready", pop: "p-foreign", kind: "room" },
    { t: "pop-say", pop: "p-foreign", seq: 0, text: "foreign chat" },
    { t: "pop-emote", pop: "p-foreign", seq: 1, kind: "clap" },
    { t: "pop-sit", pop: "p-foreign", seat: 1 },
    { t: "pop-back", pop: "p-foreign" },
    { t: "pop-bye", pop: "p-foreign" },
    { t: "room-adopt", pop: "p-foreign" },
    { t: "room-back" },
    { t: "room-gone" },
    { t: "room-log", reset: true, entries: [{ kind: "chat", nickname: "mallory", text: "foreign log", self: false }] },
    { t: "room-state", title: "foreign", people: 9, cap: 25, open: true, cooling: false, muted: false, placeholder: "foreign" },
  ];
  for (const origin of origins) {
    const foreign = await spoofer(a.context, origin);
    expect(await foreign.evaluate(() => location.origin)).toBe(origin);
    await post(foreign, [name], wellFormed);
  }
  await a.page.waitForTimeout(700);

  expect(actions(mark)).toEqual([]);
  expect(await snapshot(pop)).toEqual(before);
  expect(await b.page.locator(site.chatLogLine).allInnerTexts()).toEqual(bLines);
  await expect(a.page.locator(site.chatAway)).toBeVisible();
  await say(pop, "still me");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("spfd-1 still me");
  expect(tap.errors.slice(errors)).toEqual([]);

  // Control: the same well-formed ready from a same-origin page is heard (it is a window as far as the channel can tell,
  // so the adopted one is told to go). Without this the cases above could pass because the probe never delivers.
  const closed = pop.waitForEvent("close");
  const same = await spoofer(a.context, URLS.web);
  await post(same, [name], [{ t: "pop-ready", pop: "p-control" }]);
  await closed;
});

test("a forged sender never speaks as someone else: the server sees our member and only {type, text}", async ({ browser }) => {
  const [a, b] = await join(browser, chatRoom(), "spfe");
  const pop = await popOut(a);
  const { name } = channelOf(pop);
  const spoof = await spoofer(a.context, URLS.web);
  // Eavesdrop the adopted window's id (the room tab announces it to anyone on the channel; `room-hello` asks it to).
  await spoof.evaluate((n) => {
    const seen: unknown[] = [];
    Reflect.set(window, "__seen", seen);
    const ch = new BroadcastChannel(n);
    ch.onmessage = (ev: MessageEvent<unknown>) => {
      seen.push(ev.data);
    };
    Reflect.set(window, "__ch", ch);
    new BroadcastChannel(n).postMessage({ t: "room-hello" });
  }, name);
  const adoptedPop = await spoof.waitForFunction(() => {
    const seen: unknown = Reflect.get(window, "__seen");
    if (!Array.isArray(seen)) return null;
    for (const m of seen as unknown[]) {
      if (typeof m === "object" && m !== null && Reflect.get(m, "t") === "room-adopt") return Reflect.get(m, "pop") as unknown;
    }
    return null;
  });
  const adopted = await adoptedPop.jsonValue();
  if (typeof adopted !== "string") throw new Error("no adopt seen");
  const mark = tap.frames.length;
  const bLines = await b.page.locator(site.chatLogLine).allInnerTexts();

  // The adopted window's own id, but with fields no window sends: strict schema, dropped whole.
  const forged: unknown[] = [
    { t: "pop-say", pop: adopted, seq: 0, text: "I am b", member: "b", nickname: "spfe-2", self: false },
    { t: "pop-say", pop: adopted, seq: 0, text: "I am b", memberId: "b" },
    { t: "pop-say", pop: adopted, seq: 0, text: "I am b", from: { nickname: "spfe-2" } },
    { t: "pop-emote", pop: adopted, seq: 0, kind: "clap", member: "b" },
    { t: "pop-sit", pop: adopted, seat: 1, member: "b" },
    // And someone else's window id: not the adopted one.
    { t: "pop-say", pop: OTHER, seq: 0, text: "I am b" },
  ];
  await post(spoof, [name], forged);
  await a.page.waitForTimeout(500);
  expect(actions(mark)).toEqual([]);
  expect(await b.page.locator(site.chatLogLine).allInnerTexts()).toEqual(bLines);

  // Oversized text under the adopted id parses at the channel (cap 1000) but is no chat (cap 280): refused, nothing sent.
  // seq 0 so the real window's counter (from 1) is not shut out.
  await spoof.evaluate(
    ([n, id]) => {
      new BroadcastChannel(n).postMessage({ t: "pop-say", pop: id, seq: 0, text: "x".repeat(281) });
    },
    [name, adopted] as const,
  );
  await spoof.waitForFunction(() => {
    const seen: unknown = Reflect.get(window, "__seen");
    return Array.isArray(seen) && (seen as unknown[]).some((m) => typeof m === "object" && m !== null && Reflect.get(m, "t") === "room-said" && Reflect.get(m, "ok") === false);
  });
  expect(actions(mark)).toEqual([]);

  // The real window: one chat frame, our member, exactly the wire's {type, text}.
  await say(pop, "genuine");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("spfe-1 genuine");
  await b.page.waitForTimeout(300);
  await expect(b.page.locator(site.chatLogLine).filter({ hasText: "genuine" })).toHaveCount(1);
  const sent = actions(mark);
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0] ?? "null")).toEqual({ type: "chat", text: "genuine" });
});

test("the room window: forged seats and stage messages are dropped; its own seat click still sits us", async ({ browser }) => {
  const [a, b] = await join(browser, stageRoom(), "spfr");
  const pop = await popRoom(a);
  const { name } = channelOf(pop);
  await expect.poll(async () => (await pop.locator(site.nicknameTag).allInnerTexts()).sort()).toEqual(["spfr-1", "spfr-2"]);
  const plate = await pop.locator(site.poproomPlate).innerText();
  const seats = async (p: Page): Promise<(string | null)[]> => p.locator(site.seat).evaluateAll((els) => els.map((e) => e.getAttribute("data-occupied")));
  const seatsBefore = await seats(b.page);
  const before = await snapshot(pop);
  const spoof = await spoofer(a.context, URLS.web);
  const mark = tap.frames.length;
  const errors = tap.errors.length;
  const view = { status: "open", self: null, bubbles: [], syslines: [], catching: [] };

  const messages: unknown[] = [
    // Seat clicks that aren't the adopted window's, and ones that aren't seats.
    { t: "pop-sit", pop: OTHER, seat: 2 },
    { t: "pop-sit", pop: OTHER, seat: 7 },
    { t: "pop-sit", pop: "bad id!", seat: 2 },
    { t: "pop-sit", pop: OTHER, seat: 8 },
    { t: "pop-sit", pop: OTHER, seat: -1 },
    { t: "pop-sit", pop: OTHER, seat: 2.5 },
    { t: "pop-sit", pop: OTHER, seat: "2" },
    { t: "pop-sit", pop: OTHER, seat: 2, member: "b" },
    { t: "pop-sit", seat: 2 },
    // What the stage draws, bent: a status that isn't one, a bubble past the chat max, a missing field, an extra one.
    { t: "room-view", ...view, status: "hacked" },
    { t: "room-view", ...view, bubbles: [{ memberId: "m", text: long(281), expiresAt: 1 }] },
    { t: "room-view", ...view, room: {} },
    { t: "room-view", status: "open", self: null, bubbles: [], syslines: [] },
    { t: "room-view", ...view, extra: 1 },
    { t: "room-tv", video: "yes", playing: true, position: 5, live: false, catching: false },
    { t: "room-tv", video: true, playing: true, position: -1, live: false, catching: false },
    { t: "room-tv", video: true, playing: true, position: 99, live: false, catching: false, extra: 1 },
    { t: "room-emote", member: 5, kind: "clap" },
    { t: "room-emote", member: "m", kind: "boom" },
    { t: "room-raise", x: 1 },
    ...NOT_OBJECTS,
    ...UNKNOWN_TYPES,
  ];
  await post(spoof, [name], messages, true);
  await a.page.waitForTimeout(700);

  expect(actions(mark)).toEqual([]);
  expect(await snapshot(pop)).toEqual(before);
  await expect(pop.locator(site.nicknameTag)).toHaveCount(2);
  await expect(pop.locator(site.poproomPlate)).toHaveText(plate);
  expect(await seats(b.page)).toEqual(seatsBefore);
  await expect(a.page.locator(site.roomAway)).toBeVisible();

  // The window's own click sits us, once, and the same click stands us up again.
  const seat = pop.locator(`${site.seat}[data-seat="2"]`);
  await seat.click();
  await expect(b.page.locator(`${site.seat}[data-seat="2"]`)).toHaveAttribute("data-occupied", "true");
  await seat.click();
  await expect(b.page.locator(`${site.seat}[data-seat="2"]`)).not.toHaveAttribute("data-occupied", "true");
  expect(actions(mark).map((f) => JSON.parse(f) as unknown)).toEqual([
    { type: "sit", seat: 2 },
    { type: "sit", seat: null },
  ]);
  expect(tap.errors.slice(errors)).toEqual([]);
  await clickClosing(pop, pop.locator(site.popoutBack));
});
