import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PopMessage } from "../src/popout/channel";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-598 (M7 W3, set k `ui-m7-popout` / `ui-m7-away`): the pop-out chat window. A view only: no socket, no join. It
// shows what its room tab relays (the full log, lines settle but never fade) and hands chat and emotes back to it.
// The put-back key closes it; told to go (another pop-out was adopted, or chat was brought back) it closes; when the
// room tab goes away it shows the set (f) plug and offers to open the room in itself.

const STATE = { t: "room-state", title: "Movie night", people: 7, cap: 8, open: true, cooling: false, muted: false, placeholder: "Say something…" } as const;

async function setup() {
  const { createPopoutView, POP_PING_MS, POP_WAIT_MS } = await import("../src/popout/view");
  const posted: PopMessage[] = [];
  let deliver: (data: unknown) => void = () => undefined;
  let closed = 0;
  const went: string[] = [];
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number; every: number | null }>();
  let nextId = 1;
  const root = document.createElement("main");
  document.body.replaceChildren(root);
  document.title = "omega-share";
  const view = createPopoutView({
    root,
    document,
    pop: "p1",
    roomId: "movie-night",
    channel: {
      post: (m) => posted.push(m),
      onMessage: (fn) => {
        deliver = fn;
      },
      close: () => undefined,
    },
    closeWindow: () => {
      closed++;
    },
    navigate: (url) => went.push(url),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms, every: null });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    setInterval: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms, every: ms });
      return id;
    },
  });
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      let next: [number, { fn: () => void; at: number; every: number | null }] | null = null;
      for (const e of timers) if (e[1].at <= end && (next === null || e[1].at < next[1].at)) next = e;
      if (next === null) break;
      const [id, t] = next;
      now = t.at;
      if (t.every === null) timers.delete(id);
      else t.at += t.every;
      t.fn();
    }
    now = end;
  };
  const q = <T extends Element>(sel: string, type: new () => T): T => {
    const e = root.querySelector(sel);
    if (!(e instanceof type)) throw new Error(`missing ${sel}`);
    return e;
  };
  const from = (m: unknown): void => {
    deliver(m);
  };
  const take = (): PopMessage[] => posted.splice(0);
  const adopt = (): void => {
    from({ t: "room-adopt", pop: "p1" });
    from({ t: "room-log", reset: true, entries: [] });
    from(STATE);
    take();
  };
  return { view, root, q, from, take, adopt, closed: () => closed, went, advance, POP_PING_MS, POP_WAIT_MS };
}

describe("pop-out chat window", () => {
  test("says it's ready on load, and again when a (reloaded) room tab says hello", async () => {
    const { take, from } = await setup();
    expect(take()).toEqual([{ t: "pop-ready", pop: "p1" }]);
    from({ t: "room-hello" });
    expect(take()).toEqual([{ t: "pop-ready", pop: "p1" }]);
  });

  test("set k: a Chat head with the head count and the put-back key, the log (role=log), then emotes, field and send", async () => {
    const { q, adopt, root } = await setup();
    adopt();
    expect(root.querySelector(".ui-pop")).not.toBeNull();
    expect(q("[data-testid=popout-people]", HTMLElement).textContent).toBe("7 / 8");
    const back = q("[data-testid=popout-back]", HTMLButtonElement);
    expect(back.getAttribute("aria-label")).toBe("Put chat back in the page");
    expect(back.querySelector(".ui-icon-popout-back")).not.toBeNull();
    const log = q("[data-testid=chat-log]", HTMLOListElement);
    expect(log.getAttribute("role")).toBe("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.dataset["ageing"]).toBe("settle");
    expect(q("[data-testid=emote-key]", HTMLButtonElement)).toBeTruthy();
    expect(q("[data-testid=chat-input]", HTMLInputElement).getAttribute("aria-label")).toBe("Chat message");
    expect(q("[data-testid=chat-send]", HTMLButtonElement)).toBeTruthy();
    expect(document.title).toBe("Chat · Movie night · omega-share");
  });

  test("shows the relayed log: a reset replaces it, later lines append (text only, never markup)", async () => {
    const { from, root } = await setup();
    from({ t: "room-adopt", pop: "p1" });
    from({ t: "room-log", reset: true, entries: [{ kind: "chat", nickname: "Ada", text: "<b>hi</b>", self: false }] });
    from({ t: "room-log", reset: false, entries: [{ kind: "chat", nickname: "Me", text: "yo", self: true }] });
    const lines = () => [...root.querySelectorAll("[data-testid=chat-log-line]")].map((l) => l.textContent);
    expect(lines()).toEqual(["Ada <b>hi</b>", "Me yo"]);
    expect(root.querySelector("[data-testid=chat-log-line] b + b")).toBeNull();
    expect(root.querySelectorAll("[data-testid=chat-log-line].self")).toHaveLength(1);
    from({ t: "room-log", reset: true, entries: [{ kind: "system", line: { glyph: "pause", actor: "Ada", verb: "paused", time: "1:02" } }] });
    expect(lines()).toEqual(["Ada paused 1:02"]);
  });

  test("sending hands the text to the room tab with a rising sequence; the field clears only when the room says ok", async () => {
    const { q, take, from, adopt } = await setup();
    adopt();
    const input = q("[data-testid=chat-input]", HTMLInputElement);
    const form = q("form", HTMLFormElement);
    input.value = "hello";
    form.requestSubmit();
    expect(take()).toEqual([{ t: "pop-say", pop: "p1", seq: 1, text: "hello" }]);
    from({ t: "room-said", pop: "p1", seq: 1, ok: false });
    expect(input.value).toBe("hello");
    form.requestSubmit();
    expect(take()).toEqual([{ t: "pop-say", pop: "p1", seq: 2, text: "hello" }]);
    from({ t: "room-said", pop: "p1", seq: 2, ok: true });
    expect(input.value).toBe("");
  });

  test("one message at a time: a second Enter before the room answers sends nothing more (review)", async () => {
    const { q, take, from, adopt } = await setup();
    adopt();
    const input = q("[data-testid=chat-input]", HTMLInputElement);
    const form = q("form", HTMLFormElement);
    input.value = "hello";
    form.requestSubmit();
    form.requestSubmit();
    expect(take()).toEqual([{ t: "pop-say", pop: "p1", seq: 1, text: "hello" }]);
    from({ t: "room-said", pop: "p1", seq: 1, ok: true });
    expect(input.value).toBe("");
    input.value = "again";
    form.requestSubmit();
    expect(take()).toEqual([{ t: "pop-say", pop: "p1", seq: 2, text: "again" }]);
  });

  test("adopted, the message field takes focus, so you can type at once (review)", async () => {
    const { q, adopt } = await setup();
    adopt();
    expect(document.activeElement).toBe(q("[data-testid=chat-input]", HTMLInputElement));
  });

  test("an emote goes to the room tab too", async () => {
    const { q, take, adopt, root } = await setup();
    adopt();
    q("[data-testid=emote-key]", HTMLButtonElement).click();
    root.querySelector<HTMLButtonElement>("[data-kind=wave]")?.click();
    expect(take()).toEqual([{ t: "pop-emote", pop: "p1", seq: 1, kind: "wave" }]);
  });

  test("cooling or muted, as the room says: Send is held and the field says why", async () => {
    const { q, take, from, adopt } = await setup();
    adopt();
    from({ ...STATE, cooling: true, muted: true, placeholder: "The host muted your chat" });
    const input = q("[data-testid=chat-input]", HTMLInputElement);
    expect(input.placeholder).toBe("The host muted your chat");
    expect(input.readOnly).toBe(true);
    expect(q("[data-testid=chat-send]", HTMLButtonElement).disabled).toBe(true);
    input.value = "hi";
    q("form", HTMLFormElement).requestSubmit();
    expect(take()).toEqual([]);
  });

  test("the put-back key tells the room tab and closes the window", async () => {
    const { q, take, adopt, closed } = await setup();
    adopt();
    q("[data-testid=popout-back]", HTMLButtonElement).click();
    expect(take()).toEqual([{ t: "pop-back", pop: "p1" }]);
    expect(closed()).toBe(1);
  });

  test("told to go (chat brought back, or another pop-out adopted) it closes; adopted itself it stays", async () => {
    const a = await setup();
    a.adopt();
    a.from({ t: "room-back" });
    expect(a.closed()).toBe(1);
    const b = await setup();
    b.adopt();
    b.from({ t: "room-adopt", pop: "p2" });
    expect(b.closed()).toBe(1);
    const c = await setup();
    c.adopt();
    expect(c.closed()).toBe(0);
  });

  test("two windows ready at once: one not yet adopted ignores an adopt meant for another, so the newest survives (QA OME-635)", async () => {
    const { from, take, closed, q } = await setup();
    take();
    from({ t: "room-adopt", pop: "p0" });
    expect(closed()).toBe(0);
    from({ t: "room-adopt", pop: "p1" });
    expect(closed()).toBe(0);
    expect(q("[data-testid=chat-input]", HTMLInputElement).disabled).toBe(false);
  });

  test("superseded, it says goodbye before closing, and if the browser keeps it open it says the chat moved (QA OME-635)", async () => {
    const { adopt, from, take, closed, q } = await setup();
    adopt();
    from({ t: "room-adopt", pop: "p2" });
    expect(take()).toEqual([{ t: "pop-bye", pop: "p1" }]);
    expect(closed()).toBe(1);
    const away = q("[data-testid=popout-gone]", HTMLElement);
    expect(away.hidden).toBe(false);
    expect(away.textContent).toContain("Chat moved to another window.");
    expect(q("[data-testid=popout-open-room]", HTMLButtonElement).hidden).toBe(true);
    expect(q("[data-testid=chat-input]", HTMLInputElement).disabled).toBe(true);
  });

  test("the head count has words for a screen reader (QA OME-635)", async () => {
    const { adopt, root } = await setup();
    adopt();
    expect(root.querySelector(".popout-people")?.textContent).toBe("7 / 8 people");
  });

  test("pings the room tab while open, so a window closed without a word is noticed", async () => {
    const { adopt, take, advance, POP_PING_MS } = await setup();
    adopt();
    advance(POP_PING_MS * 2);
    expect(take()).toEqual([{ t: "pop-ping", pop: "p1" }, { t: "pop-ping", pop: "p1" }]);
  });

  test("the room tab gone: the plug, the field held, and 'Open the room here' or 'Close'", async () => {
    const { q, from, adopt, went, closed, root } = await setup();
    adopt();
    from({ t: "room-gone" });
    const away = q("[data-testid=popout-gone]", HTMLElement);
    expect(away.hidden).toBe(false);
    expect(away.getAttribute("role")).toBe("status");
    expect(away.textContent).toContain("The room's tab was closed or reloaded.");
    expect(away.querySelector(".ui-icon-unplugged")).not.toBeNull();
    expect(q("[data-testid=chat-input]", HTMLInputElement).disabled).toBe(true);
    q("[data-testid=popout-open-room]", HTMLButtonElement).click();
    expect(went).toEqual(["/r/movie-night"]);
    q("[data-testid=popout-close]", HTMLButtonElement).click();
    expect(closed()).toBe(1);
    // A reloaded room tab adopts it again: the plug goes.
    from({ t: "room-adopt", pop: "p1" });
    expect(away.hidden).toBe(true);
    expect(q("[data-testid=chat-input]", HTMLInputElement).disabled).toBe(false);
    expect(root.contains(away)).toBe(true);
  });

  test("never adopted (opened by hand, or the room tab is gone already): the plug after a short wait", async () => {
    const { q, advance, POP_WAIT_MS } = await setup();
    const away = q("[data-testid=popout-gone]", HTMLElement);
    expect(away.hidden).toBe(true);
    advance(POP_WAIT_MS);
    expect(away.hidden).toBe(false);
  });

  test("malformed messages are dropped", async () => {
    const { from, closed, root } = await setup();
    from({ t: "room-back", extra: 1 });
    from({ t: "room-log", reset: true, entries: [{ kind: "chat", nickname: "A" }] });
    expect(closed()).toBe(0);
    expect(root.querySelectorAll("[data-testid=chat-log-line]")).toHaveLength(0);
  });
});
