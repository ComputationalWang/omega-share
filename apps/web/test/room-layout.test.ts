import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createChatLog } from "../src/chat/log";
import { createPlaybackController } from "../src/controls/playback";
import { createQueuePanel } from "../src/controls/queue-panel";

// OME-1100: where the room page's pieces sit (page, wide column, phone, full screen and its chat strip), split out of
// room.ts. The chat goes under the notices in the page and into the side column on a wide screen; the strip remembers
// whether it was collapsed.

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://omega.example/r/main" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  localStorage.clear();
});

const div = (): HTMLElement => document.createElement("div");

async function setup(o: { wide?: boolean; short?: boolean } = {}) {
  const { createRoomLayout } = await import("../src/room-layout");
  const { createRoomTv } = await import("../src/room-tv");
  const playback = createPlaybackController({ send: () => true, clock: { ready: false, serverNow: () => 0, tick: () => undefined }, now: () => 0, setInterval: () => 0, clearInterval: () => undefined });
  const root = div();
  const wrap = div();
  const clip = div();
  const stage = div();
  clip.append(stage);
  let fsMode = "off";
  const tv = createRoomTv({ playback, extension: { whenPresent: () => undefined, unlock: () => Promise.resolve("unsupported" as const), relock: () => undefined }, wrap, fullscreen: () => fsMode !== "off", onProvider: () => undefined });
  wrap.append(tv.tv, tv.controls, clip);
  const log = createChatLog({ ageing: "settle", now: () => 0, setTimer: () => 0, clearTimer: () => undefined });
  const form = document.createElement("form");
  const pickerRoot = div();
  const popOut = div();
  form.append(pickerRoot, popOut);
  const away = div();
  const queue = createQueuePanel({ send: () => true, ownHosts: ["omega.example"] });
  const notice = div();
  const roomAway = div();
  const roomTop = div();
  const people = div();
  people.hidden = true;
  const invite = div();
  const poll = div();
  const side = div();
  const ownerBar = div();
  const editorPanel = div();
  const foot = div();
  root.append(roomTop, people, wrap, roomAway, ownerBar, editorPanel, tv.personal, queue.root, notice, log.root, form, invite, side, foot);
  document.body.replaceChildren(root);
  const layout = createRoomLayout({
    root, wrap, clip, stage, tv, log, poll, queue, notice, roomAway, roomTop, people, invite, foot, side, ownerBar, editorPanel,
    composer: { form, away, popOut, picker: { root: pickerRoot, close: () => undefined } },
    settings: [],
    phone: { matches: false },
    coarse: { matches: false },
    portrait: { matches: false },
    wide: { matches: o.wide === true },
    short: { matches: o.short === true },
    stageShown: () => true,
    roomOut: () => false,
    hint: { dismiss: () => undefined },
    placeRoom: () => undefined,
  });
  fsMode = layout.fs.mode();
  return { layout, root, wrap, log, poll, form, notice, side, queue, roomTop, people, invite, foot, ownerBar, editorPanel };
}

describe("room layout", () => {
  test("in the page the chat sits right under the notices", async () => {
    const { log, poll, form, notice, side } = await setup();
    // The poll card (OME-1454) is pinned right above the log.
    expect(notice.nextElementSibling).toBe(poll);
    expect(poll.nextElementSibling).toBe(log.root);
    expect(log.root.nextElementSibling).toBe(form);
    expect(side.hidden).toBe(true);
    expect(document.body.classList.contains("room-is-wide")).toBe(false);
  });

  test("on a wide screen the invite, Up next and the chat make the side column", async () => {
    const { root, log, form, side, queue, invite } = await setup({ wide: true });
    expect(root.classList.contains("room-wide")).toBe(true);
    // OME-1755: the page's wide rules key on a body class, not body:has(), which re-styles the page on every chat line.
    expect(document.body.classList.contains("room-is-wide")).toBe(true);
    expect(side.hidden).toBe(false);
    expect(invite.parentElement).toBe(side);
    expect(queue.root.parentElement).toBe(side);
    expect(log.root.parentElement).toBe(side);
    expect(form.parentElement).toBe(side);
  });

  test("People is a tab of the chat column on a wide screen, above the owner's bar and the log; elsewhere under the head row (OME-1805)", async () => {
    const wide = await setup({ wide: true });
    expect(wide.people.parentElement).toBe(wide.side);
    expect(wide.people.nextElementSibling).toBe(wide.ownerBar);
    const page = await setup();
    expect(page.roomTop.nextElementSibling).toBe(page.people);
  });

  test("the owner's bar ends the People tab on a wide screen, Report room too on a short one (OME-1841, OME-1842)", async () => {
    const tall = await setup({ wide: true });
    expect(tall.people.nextElementSibling).toBe(tall.ownerBar);
    expect(tall.ownerBar.nextElementSibling).toBe(tall.log.root);
    expect(tall.foot.parentElement).toBe(tall.root);
    // Open, People holds the bar at its end, so they scroll as one (OME-1842); closed, it's back above the log.
    tall.people.append(div());
    tall.people.hidden = false;
    await Promise.resolve();
    expect(tall.people.lastElementChild).toBe(tall.ownerBar);
    tall.people.hidden = true;
    await Promise.resolve();
    expect(tall.people.nextElementSibling).toBe(tall.ownerBar);
    const short = await setup({ wide: true, short: true });
    short.people.hidden = false;
    await Promise.resolve();
    expect(short.people.nextElementSibling).toBe(short.ownerBar);
    expect(short.ownerBar.nextElementSibling).toBe(short.foot);
    expect(short.foot.parentElement).toBe(short.side);
    const narrow = await setup({ wide: false, short: true });
    expect(narrow.ownerBar.nextElementSibling).toBe(narrow.editorPanel);
  });

  test("a short wide screen moves the head row, holding the invite, to the top of the chat column (OME-1595)", async () => {
    const tall = await setup({ wide: true });
    expect(tall.root.firstElementChild).toBe(tall.roomTop);
    const short = await setup({ wide: true, short: true });
    expect(short.roomTop.parentElement).toBe(short.side);
    expect(short.invite.parentElement).toBe(short.roomTop);
    expect(short.roomTop.nextElementSibling).toBe(short.queue.root);
  });

  test("the strip's collapse key is remembered on this device", async () => {
    const { wrap } = await setup();
    const strip = wrap.querySelector<HTMLElement>('[data-testid="fs-strip"]');
    expect(strip?.dataset["strip"]).toBe("open");
    wrap.querySelector<HTMLButtonElement>('[data-testid="fs-strip-toggle"]')?.click();
    expect(strip?.dataset["strip"]).toBe("band");
    expect(localStorage.getItem("omega.fsStrip")).toBe("band");
    const again = await setup();
    expect(again.wrap.querySelector<HTMLElement>('[data-testid="fs-strip"]')?.dataset["strip"]).toBe("band");
  });

  test("the full-screen key on the shelf starts in the page", async () => {
    const { layout, wrap } = await setup();
    expect(layout.fs.mode()).toBe("off");
    expect(wrap.querySelector<HTMLElement>('[data-testid="fullscreen-toggle"]')?.ariaLabel).toBe("Full screen");
  });
});
