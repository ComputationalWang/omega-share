// The pop-out chat window (OME-598, M7 W3, set k `ui-m7-popout` / `ui-m7-away`). A view of its room tab's chat: no
// socket, no join, no Pixi. The room tab relays the log (the full log here: lines settle but never fade) and the chat
// state; chat and emotes go back to it to send. The mustard rim (.ui-pop) says "yours". The put-back key closes the
// window and the chat returns to the page; told to go (chat brought back in the page, or a newer window adopted) it
// closes; when the room tab goes away it shows the set (f) plug and offers to open the room in itself.
import type { RoomId } from "@omega/shared";
import { createChatLog } from "../chat/log";
import { el, sprite } from "../controls/dom";
import { createEmotePicker } from "../emote/picker";
import { parsePopMessage, type PopChannel } from "./channel";

/** How often the window tells its room tab it's still there (relay.ts POP_LEASE_MS lets it go after long silence). */
export const POP_PING_MS = 5000;
/** Not adopted by then (opened by hand, or the room tab is gone already): show the plug. */
export const POP_WAIT_MS = 3000;

export interface PopoutViewOptions<H> {
  readonly root: HTMLElement;
  readonly document: Document;
  /** This window load's id. */
  readonly pop: string;
  readonly roomId: RoomId;
  readonly channel: PopChannel;
  readonly closeWindow: () => void;
  readonly navigate: (url: string) => void;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => H;
  readonly clearTimer: (h: H) => void;
  readonly setInterval: (fn: () => void, ms: number) => H;
}

export interface PopoutView {
  /** A keydown on the window: keys 1–6 emote, Escape closes the picker. True if it was ours. */
  key(ev: KeyboardEvent): boolean;
  /** The window is closing (pagehide): tell the room tab. */
  bye(): void;
}

export function createPopoutView<H>(o: PopoutViewOptions<H>): PopoutView {
  const { pop } = o;
  let seq = 0;
  /** The pop-say waiting for its answer: the field clears when it went out. */
  let pending: number | null = null;
  let adopted = false;
  let gone = false;
  let held = false;

  const frame = el("div", { className: "ui-pop popout" });
  const head = el("div", { className: "popout-head" });
  const people = el("span", { className: "popout-people-n" }, "popout-people");
  const back = el("button", { type: "button", className: "ui-button self icon", title: "Put chat back in the page" }, "popout-back");
  back.setAttribute("aria-label", "Put chat back in the page");
  back.append(sprite("ui-icon-popout-back"));
  const count = el("span", { className: "popout-people" });
  count.append(sprite("ui-icon-people"), people);
  head.append(sprite("ui-icon-chat"), el("span", { className: "popout-title", textContent: "Chat" }), count, back);

  const log = createChatLog({ ageing: "settle", now: o.now, setTimer: o.setTimer, clearTimer: o.clearTimer });

  const form = el("form", { className: "popout-chat" });
  const input = el("input", { type: "text", maxLength: 280, placeholder: "Say something…", autocomplete: "off" }, "chat-input");
  input.setAttribute("aria-label", "Chat message");
  const send = el("button", { type: "submit", className: "ui-button icon", title: "Send" }, "chat-send");
  send.setAttribute("aria-label", "Send");
  send.append(sprite("ui-icon-send"));
  const picker = createEmotePicker({
    send: (m) => {
      if (m.type !== "emote" || !adopted || gone) return false;
      o.channel.post({ t: "pop-emote", pop, seq: ++seq, kind: m.kind });
      return true;
    },
    now: o.now,
    setTimer: (fn, ms) => o.setTimer(fn, ms),
    clearTimer: (h) => {
      o.clearTimer(h as H);
    },
  });
  form.append(picker.root, input, send);

  // Set (k) "the pop-out after the main tab closed": the plug, what happened, and what you can do here.
  const away = el("div", { className: "ui-panel ui-away popout-gone", role: "status", hidden: true }, "popout-gone");
  const awayText = el("p");
  awayText.append(el("b", { textContent: "The room's tab was closed." }), el("br"), "This window talks through it, so it left the room too.");
  const openRoom = el("button", { type: "button", className: "ui-button", textContent: "Open the room here" }, "popout-open-room");
  const close = el("button", { type: "button", className: "ui-button secondary", textContent: "Close" }, "popout-close");
  const awayKeys = el("div", { className: "popout-gone-keys" });
  awayKeys.append(openRoom, close);
  away.append(sprite("ui-icon-unplugged"), awayText, awayKeys);

  frame.append(head, log.root, form, away);
  o.root.replaceChildren(frame);

  /** The field and keys work only while a room tab is behind them and the room lets me talk. */
  const renderForm = (): void => {
    const off = gone || !adopted;
    input.disabled = off;
    input.readOnly = held;
    send.disabled = off || held;
    picker.root.inert = off;
  };
  const setGone = (on: boolean): void => {
    gone = on;
    away.hidden = !on;
    renderForm();
  };
  renderForm();

  const wait = o.setTimer(() => {
    if (!adopted) setGone(true);
  }, POP_WAIT_MS);
  o.setInterval(() => {
    if (adopted && !gone) o.channel.post({ t: "pop-ping", pop });
  }, POP_PING_MS);

  o.channel.onMessage((data) => {
    const m = parsePopMessage(data);
    if (m === null) return;
    switch (m.t) {
      case "room-hello":
        o.channel.post({ t: "pop-ready", pop });
        return;
      case "room-adopt":
        if (m.pop !== pop) {
          o.closeWindow();
          return;
        }
        o.clearTimer(wait);
        setGone(false);
        if (!adopted) {
          adopted = true;
          renderForm();
          // Open from a click in the room tab: you came here to type.
          input.focus({ preventScroll: true });
        }
        return;
      case "room-log":
        if (m.reset) log.clear();
        for (const e of m.entries) log.append(e);
        return;
      case "room-state":
        o.document.title = m.title === null ? "Chat · omega-share" : `Chat · ${m.title} · omega-share`;
        people.textContent = `${String(m.people)} / ${String(m.cap)}`;
        held = m.cooling || m.muted || !m.open;
        if (input.placeholder !== m.placeholder) input.placeholder = m.placeholder;
        input.classList.toggle("is-muted", m.muted);
        form.dataset["muted"] = String(m.muted);
        form.dataset["cooldown"] = String(m.cooling);
        renderForm();
        return;
      case "room-said":
        if (m.pop === pop && m.seq === pending) {
          // One message at a time: the field takes the next once this one is answered.
          pending = null;
          if (m.ok) input.value = "";
        }
        return;
      case "room-back":
        o.closeWindow();
        return;
      case "room-gone":
        setGone(true);
        return;
      // A window's own kind (another window's): not for us.
      case "pop-ready":
      case "pop-ping":
      case "pop-say":
      case "pop-emote":
      case "pop-back":
      case "pop-bye":
        return;
    }
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!adopted || gone || held || pending !== null) return;
    const text = input.value;
    if (text.trim() === "") return;
    pending = ++seq;
    o.channel.post({ t: "pop-say", pop, seq: pending, text });
  });
  back.addEventListener("click", () => {
    o.channel.post({ t: "pop-back", pop });
    o.closeWindow();
  });
  openRoom.addEventListener("click", () => {
    o.navigate(`/r/${o.roomId}`);
  });
  close.addEventListener("click", () => {
    o.closeWindow();
  });

  o.channel.post({ t: "pop-ready", pop });

  return {
    key: (ev) => adopted && !gone && picker.key(ev),
    bye() {
      o.channel.post({ t: "pop-bye", pop });
    },
  };
}
