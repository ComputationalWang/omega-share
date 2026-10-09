// The room tab's end of the pop-out chat (OME-598, M7 W3, R-M7a Q3 a). The tab keeps the one WebSocket: the window is
// a view that never joins. Lines and the chat state go over the channel; chat and emotes come back and are sent here on
// the socket, under the tab's own cooldown and mute. One pop-out per tab: the newest window that says it's ready is
// adopted (any other is told to go and is ignored from then on), and its chat is sent once however often a message
// arrives (de-duplicated by the window's sequence number).
import type { ClientMessage } from "@omega/shared";
import { CHAT_LOG_CAP, type ChatLogEntry } from "../chat/log";
import { chatIntent } from "../intents";
import { parsePopMessage, type PopChannel, type PopState } from "./channel";

/**
 * A window that's gone without a word (crashed, killed) is let go after this long without a message. Generous: a
 * minimised window's ping timer can be throttled to once a minute (Chrome's intensive throttling), and a normal close
 * says `pop-bye` at once.
 */
export const POP_LEASE_MS = 150_000;

export interface ChatRelayOptions<H> {
  readonly channel: PopChannel;
  /** The room's socket (Connection.send): true if it went out. */
  readonly send: (m: ClientMessage) => boolean;
  /** Opens the pop-out window (window.open, noopener). */
  readonly openWindow: () => void;
  /** The chat moved into the window (true) or came back to the page (false). */
  readonly onPopped: (on: boolean) => void;
  readonly setTimer: (fn: () => void, ms: number) => H;
  readonly clearTimer: (h: H) => void;
}

export interface ChatRelay {
  popped(): boolean;
  popOut(): void;
  bringBack(): void;
  /** A new chat log line (the page's log gets it too). */
  append(entry: ChatLogEntry): void;
  /** The room's chat state; posted when popped out and changed. */
  update(s: PopState): void;
  /** The room tab is going away (pagehide). */
  close(): void;
}

const sameState = (a: PopState | null, b: PopState): boolean =>
  a !== null && a.title === b.title && a.people === b.people && a.cap === b.cap && a.open === b.open && a.cooling === b.cooling && a.muted === b.muted && a.placeholder === b.placeholder;

export function createChatRelay<H>(o: ChatRelayOptions<H>): ChatRelay {
  const backlog: ChatLogEntry[] = [];
  let state: PopState | null = null;
  /** The last state the window was sent. */
  let posted: PopState | null = null;
  let active: string | null = null;
  let lastSeq = -1;
  let lease: H | null = null;

  const renew = (): void => {
    if (lease !== null) o.clearTimer(lease);
    lease = active === null ? null : o.setTimer(() => {
      lease = null;
      release();
    }, POP_LEASE_MS);
  };

  const postState = (): void => {
    if (state === null || sameState(posted, state)) return;
    posted = state;
    o.channel.post({ t: "room-state", ...state });
  };

  const release = (): void => {
    if (active === null) return;
    active = null;
    posted = null;
    renew();
    o.onPopped(false);
  };

  const adopt = (pop: string): void => {
    const was = active;
    active = pop;
    lastSeq = -1;
    posted = null;
    renew();
    o.channel.post({ t: "room-adopt", pop });
    o.channel.post({ t: "room-log", reset: true, entries: backlog.slice() });
    postState();
    if (was === null) o.onPopped(true);
  };

  /** Chat, unless the room holds it (cooling or muted, as the page's own form would). */
  const say = (text: string): boolean => {
    if (state?.cooling === true || state?.muted === true) return false;
    const msg = chatIntent(text);
    return msg !== null && o.send(msg);
  };

  /** A message from the adopted window (any other is ignored): it's alive. */
  const fromActive = (pop: string): boolean => {
    if (pop !== active) return false;
    renew();
    return true;
  };
  const sent = (pop: string, seq: number, send: () => boolean): void => {
    if (!fromActive(pop) || seq <= lastSeq) return;
    lastSeq = seq;
    o.channel.post({ t: "room-said", pop, seq, ok: send() });
  };

  o.channel.onMessage((data) => {
    const m = parsePopMessage(data);
    if (m === null) return;
    switch (m.t) {
      case "pop-ready":
        adopt(m.pop);
        return;
      case "pop-ping":
        fromActive(m.pop);
        return;
      case "pop-say":
        sent(m.pop, m.seq, () => say(m.text));
        return;
      case "pop-emote":
        sent(m.pop, m.seq, () => o.send({ type: "emote", kind: m.kind }));
        return;
      case "pop-back":
      case "pop-bye":
        if (fromActive(m.pop)) release();
        return;
      // The room tab's own kind (another tab's, or ours echoed): not for us.
      case "room-hello":
      case "room-adopt":
      case "room-log":
      case "room-state":
      case "room-said":
      case "room-back":
      case "room-gone":
        return;
    }
  });
  o.channel.post({ t: "room-hello" });

  return {
    popped: () => active !== null,
    popOut() {
      o.openWindow();
    },
    bringBack() {
      if (active === null) return;
      o.channel.post({ t: "room-back" });
      release();
    },
    append(entry) {
      backlog.push(entry);
      if (backlog.length > CHAT_LOG_CAP) backlog.shift();
      if (active !== null) o.channel.post({ t: "room-log", reset: false, entries: [entry] });
    },
    update(s) {
      state = s;
      if (active !== null) postState();
    },
    close() {
      o.channel.post({ t: "room-gone" });
    },
  };
}
