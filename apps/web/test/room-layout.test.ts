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

async function setup(o: { wide?: boolean; short?: boolean; video?: boolean; coarse?: boolean; portrait?: boolean } = {}) {
  const { createRoomLayout } = await import("../src/room-layout");
  const { createRoomTv } = await import("../src/room-tv");
  const playback = createPlaybackController({ send: () => true, clock: { ready: false, serverNow: () => 0, tick: () => undefined }, now: () => 0, setInterval: () => 0, clearInterval: () => undefined });
  const root = div();
  const wrap = div();
  const clip = div();
  const stage = div();
  clip.append(stage);
  let fsMode = "off";
  const tv = createRoomTv({ playback, extension: { whenPresent: () => undefined, unlock: () => Promise.resolve("unsupported" as const), relock: () => undefined, toFrame: () => undefined, onFrame: () => () => undefined }, wrap, fullscreen: () => fsMode !== "off", onProvider: () => undefined, onCurtain: () => undefined });
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
    root, wrap, clip, stage, tv: o.video === true ? { ...tv, provider: () => "youtube" as const } : tv, log, poll, queue, notice, live: [notice], roomAway, roomTop, people, invite, foot, side, ownerBar, editorPanel,
    composer: { form, away, popOut, picker: { root: pickerRoot, close: () => undefined } },
    settings: [],
    phone: { matches: false },
    coarse: { matches: o.coarse === true },
    portrait: { matches: o.portrait === true },
    wide: { matches: o.wide === true },
    short: { matches: o.short === true },
    stageShown: () => true,
    roomOut: () => false,
    hint: { dismiss: () => undefined },
    placeRoom: () => undefined,
  });
  fsMode = layout.fs.mode();
  return { layout, root, wrap, clip, stage, tv, log, poll, form, notice, side, queue, roomTop, people, invite, foot, ownerBar, editorPanel };
}

// OME-2265: building the layout runs while the room's DOM is half made; a window size read there forces a layout of it.
test("building the room's layout reads no window size", async () => {
  const native = Object.getOwnPropertyDescriptor(window, "innerWidth");
  let reads = 0;
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => (reads++, 390) });
  try {
    await setup();
  } finally {
    if (native !== undefined) Object.defineProperty(window, "innerWidth", native);
  }
  expect(reads).toBe(0);
});

// OME-2280: the stage hands over its seats inside the room's render, after it has written. Only the desktop band frames
// them; any other refit there reads the wrap's size and forces a layout for nothing.
test("new seats read no layout unless the band frames them", async () => {
  const { layout, wrap } = await setup();
  let reads = 0;
  for (const k of ["clientWidth", "clientHeight"] as const) Object.defineProperty(wrap, k, { configurable: true, get: () => (reads++, 600) });
  layout.seats([{ x: 10, y: 10 }], []);
  expect(reads).toBe(0);
});

// OME-2280: on a phone the Room sheet starts under the picture. Measuring that in every fit (the first one runs inside the
// room's render) forced a layout; it's measured when the sheet opens.
test("a portrait fit measures the sheet's top only when the sheet opens", async () => {
  const { layout, root, tv } = await setup({ portrait: true });
  let reads = 0;
  tv.tv.getBoundingClientRect = () => (reads++, new DOMRect(0, 0, 390, 220));
  layout.syncPortrait();
  layout.fit();
  expect(layout.portraitOn()).toBe(true);
  expect(reads).toBe(0);
  layout.dock.link.click();
  expect(layout.dock.sheet.open).toBe(true);
  expect(reads).toBe(1);
  expect(root.style.getPropertyValue("--portrait-sheet-top")).toMatch(/^\d+px$/);
});

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

  test("the chat column says whether People or a poll is open in it, by class: :has() re-styled it per chat line (OME-1985)", async () => {
    const wide = await setup({ wide: true });
    expect(wide.side.classList.contains("people-open")).toBe(false);
    wide.people.hidden = false;
    await Promise.resolve();
    expect(wide.side.classList.contains("people-open")).toBe(true);
    wide.people.hidden = true;
    await Promise.resolve();
    expect(wide.side.classList.contains("people-open")).toBe(false);
    expect(wide.poll.parentElement).toBe(wide.side);
    wide.poll.hidden = false;
    await Promise.resolve();
    expect(wide.side.classList.contains("poll-open")).toBe(true);
    wide.poll.hidden = true;
    await Promise.resolve();
    expect(wide.side.classList.contains("poll-open")).toBe(false);
    // Out of the column (the page layout), an open People or poll isn't the column's.
    const page = await setup();
    page.people.hidden = false;
    page.poll.hidden = false;
    await Promise.resolve();
    expect(page.side.classList.contains("people-open")).toBe(false);
    expect(page.side.classList.contains("poll-open")).toBe(false);
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
    // The editor follows its Done key, then Report room (OME-1927).
    expect(short.ownerBar.nextElementSibling).toBe(short.editorPanel);
    expect(short.editorPanel.nextElementSibling).toBe(short.foot);
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
  // OME-2148 CI: the band's fit (ADR 0060) shrank the room with no video too (0.86× at 1280×800), where it isn't a band.
  test("with no video on a wide screen the room keeps its whole scale, however tall its audience", async () => {
    const { layout, wrap, stage } = await setup({ wide: true });
    Object.defineProperty(wrap, "clientWidth", { value: 888 });
    Object.defineProperty(wrap, "clientHeight", { value: 727 });
    layout.seats([{ x: 300, y: 200 }], [{ x: 600, y: 560 }]);
    expect(stage.style.getPropertyValue("--stage-scale")).toBe("1");
  });

  // OME-2170 (CEO decision C): one labelled key gives the room the column at 1280×800, and back. OME-2195: remembered.
  test("the Room view key shrinks the TV to its floor and fits the room at about 1×, without touching the player", async () => {
    const { layout, wrap, stage, tv } = await setup({ wide: true, video: true });
    Object.defineProperty(wrap, "clientWidth", { value: 905 });
    Object.defineProperty(wrap, "clientHeight", { value: 655 });
    layout.seats([{ x: 480, y: 300 }], [{ x: 480, y: 500 }]);
    const key = wrap.querySelector<HTMLButtonElement>('[data-testid="room-view-key"]');
    expect(key?.tagName).toBe("BUTTON");
    expect(key?.textContent).toBe("Room view");
    expect(key?.hidden).toBe(false);
    expect(key?.ariaPressed).toBe("false");
    const player = tv.tv.firstChild;
    const heroScale = Number(stage.style.getPropertyValue("--stage-scale"));
    key?.click();
    expect(key?.ariaPressed).toBe("true");
    expect(tv.tv.style.width).toBe("356px");
    expect(Number(stage.style.getPropertyValue("--stage-scale"))).toBeGreaterThan(heroScale);
    expect(Number(stage.style.getPropertyValue("--stage-scale"))).toBeGreaterThanOrEqual(40 / 41);
    expect(tv.tv.firstChild).toBe(player);
    key?.click();
    expect(key?.ariaPressed).toBe("false");
    expect(Number(stage.style.getPropertyValue("--stage-scale"))).toBe(heroScale);
    expect(localStorage.getItem("omega.roomView")).toBe("off");
  });

  // OME-2195 (ADR 0060 amendment 3): Room view is the default from 1100 px wide; an explicit choice beats it, on reload too.
  const atWidth = (w: number): void => {
    Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  };
  test("a fresh visit 1100 px wide or more opens in Room view; narrower opens video first", async () => {
    const width = window.innerWidth;
    try {
      for (const [w, on] of [[1280, true], [1100, true], [1099, false]] as const) {
        atWidth(w);
        const { layout, wrap, tv } = await setup({ wide: true, video: true });
        Object.defineProperty(wrap, "clientWidth", { value: 905 });
        Object.defineProperty(wrap, "clientHeight", { value: 655 });
        layout.seats([{ x: 480, y: 300 }], [{ x: 480, y: 500 }]);
        expect(wrap.querySelector<HTMLButtonElement>('[data-testid="room-view-key"]')?.ariaPressed).toBe(String(on));
        expect(tv.tv.style.width === "356px").toBe(on);
      }
    } finally {
      atWidth(width);
    }
  });

  test("the viewer's own choice beats the default, either way, and is kept for the next visit", async () => {
    const width = window.innerWidth;
    try {
      for (const [w, stored] of [[1280, "off"], [1024, "on"]] as const) {
        atWidth(w);
        localStorage.setItem("omega.roomView", stored);
        const { layout, wrap } = await setup({ wide: true, video: true });
        Object.defineProperty(wrap, "clientWidth", { value: 905 });
        Object.defineProperty(wrap, "clientHeight", { value: 655 });
        layout.seats([{ x: 480, y: 300 }], [{ x: 480, y: 500 }]);
        const key = wrap.querySelector<HTMLButtonElement>('[data-testid="room-view-key"]');
        expect(key?.ariaPressed).toBe(String(stored === "on"));
        key?.click();
        expect(localStorage.getItem("omega.roomView")).toBe(stored === "on" ? "off" : "on");
      }
      // Anything else in storage is no choice: the default.
      atWidth(1280);
      localStorage.setItem("omega.roomView", "yes");
      const { layout, wrap } = await setup({ wide: true, video: true });
      layout.seats([{ x: 480, y: 300 }], []);
      expect(wrap.querySelector<HTMLButtonElement>('[data-testid="room-view-key"]')?.ariaPressed).toBe("true");
    } finally {
      atWidth(width);
    }
  });

  // QA OME-2183: each fit hid the key first, and hiding it dropped its focus to <body>; a second Enter did nothing.
  test("the Room view key keeps its focus across its own toggles, never hidden in between", async () => {
    const { layout, wrap } = await setup({ wide: true, video: true });
    Object.defineProperty(wrap, "clientWidth", { value: 905 });
    Object.defineProperty(wrap, "clientHeight", { value: 655 });
    layout.seats([{ x: 480, y: 300 }], [{ x: 480, y: 500 }]);
    const key = wrap.querySelector<HTMLButtonElement>('[data-testid="room-view-key"]');
    if (key === null) throw new Error("no Room view key");
    key.focus();
    // happy-dom keeps focus on a hidden element; a browser blurs it. So watch the key never being hidden.
    const hidden = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden");
    let hides = 0;
    Object.defineProperty(key, "hidden", {
      get: (): boolean => hidden?.get?.call(key) === true,
      set: (v: boolean) => {
        if (v) hides++;
        hidden?.set?.call(key, v);
      },
    });
    key.click();
    expect(document.activeElement).toBe(key);
    key.click();
    expect(document.activeElement).toBe(key);
    expect(key.ariaPressed).toBe("false");
    expect(hides).toBe(0);
  });

  // QA OME-1330 R1 in CI: the key sat over seat 4 of the touch window at 844×390. A phone sideways has its own window.
  test("a touch screen's phone window has no Room view key over its seats", async () => {
    const { layout, wrap } = await setup({ wide: true, video: true, coarse: true });
    Object.defineProperty(wrap, "clientWidth", { value: 600 });
    Object.defineProperty(wrap, "clientHeight", { value: 330 });
    layout.seats([{ x: 480, y: 300 }], []);
    expect(wrap.querySelector<HTMLButtonElement>('[data-testid="room-view-key"]')?.hidden ?? true).toBe(true);
  });

  test("without a video there's no Room view key to press", async () => {
    const { wrap } = await setup({ wide: true });
    expect(wrap.querySelector<HTMLButtonElement>('[data-testid="room-view-key"]')?.hidden ?? true).toBe(true);
  });
});
