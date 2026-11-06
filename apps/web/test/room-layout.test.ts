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
describe("room layout", () => {
  // The Doorstep desk panel (OME-2306): one panel, the invite on top, Chat / Up next / Room, the composer at its foot.
  test("below the wide page the panel sits right under the notices, its tabs right over the composer", async () => {
    const { layout, log, poll, form, notice, side, queue, invite } = await setup();
    const { panel } = layout;
    expect(notice.nextElementSibling).toBe(panel.root);
    expect(invite.parentElement).toBe(panel.head);
    // The poll card (OME-1454) is pinned right above the log.
    expect(poll.nextElementSibling).toBe(log.root);
    expect(log.root.parentElement).toBe(panel.panels.chat);
    expect(queue.root.parentElement).toBe(panel.panels.queue);
    expect(panel.root.lastElementChild).toBe(form);
    expect(form.previousElementSibling).toBe(panel.tabs);
    expect(side.hidden).toBe(true);
    expect(document.body.classList.contains("room-is-wide")).toBe(false);
  });

  test("on a wide screen the panel is the side column, its tabs under the invite", async () => {
    const { layout, root, log, form, side, queue, invite } = await setup({ wide: true });
    const { panel } = layout;
    expect(root.classList.contains("room-wide")).toBe(true);
    // OME-1755: the page's wide rules key on a body class, not body:has(), which re-styles the page on every chat line.
    expect(document.body.classList.contains("room-is-wide")).toBe(true);
    expect(side.hidden).toBe(false);
    expect(panel.root.parentElement).toBe(side);
    expect(invite.parentElement).toBe(panel.head);
    expect(panel.head.nextElementSibling).toBe(panel.tabs);
    expect(queue.root.parentElement).toBe(panel.panels.queue);
    expect(log.root.parentElement).toBe(panel.panels.chat);
    expect(panel.root.lastElementChild).toBe(form);
  });

  test("People takes the log's place on the Chat tab on a wide screen, and opening it shows that tab; elsewhere under the picture (OME-1805)", async () => {
    const wide = await setup({ wide: true });
    expect(wide.people.nextElementSibling).toBe(wide.log.root);
    wide.layout.panel.select("queue");
    wide.people.hidden = false;
    await Promise.resolve();
    expect(wide.layout.panel.selected()).toBe("chat");
    const page = await setup();
    expect(page.wrap.nextElementSibling).toBe(page.people);
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
    expect(wide.side.contains(wide.poll)).toBe(true);
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

  test("the Room tab holds the owner's bar, the editor under its Done key, and Report room, in every layout", async () => {
    for (const o of [{ wide: true }, { wide: true, short: true }, {}]) {
      const { layout, ownerBar, editorPanel, foot } = await setup(o);
      expect(ownerBar.parentElement).toBe(layout.panel.panels.room);
      expect(ownerBar.nextElementSibling).toBe(editorPanel);
      expect(editorPanel.nextElementSibling).toBe(foot);
    }
  });

  test("a short wide screen moves the head row to the top of the column, the panel under it (OME-1595)", async () => {
    const tall = await setup({ wide: true });
    expect(tall.root.firstElementChild).toBe(tall.roomTop);
    const short = await setup({ wide: true, short: true });
    expect(short.roomTop.parentElement).toBe(short.side);
    expect(short.roomTop.nextElementSibling).toBe(short.layout.panel.root);
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
