// The room tab's end of the pop-out chat (OME-598, M7 W3, R-M7a Q3 a). The tab keeps the one WebSocket: the window is
// a view that never joins. Lines and the chat state go over the channel; chat and emotes come back and are sent here on
// the socket, under the tab's own cooldown and mute. One pop-out per tab: the newest window that says it's ready is
// adopted (any other is told to go and is ignored from then on), and its chat is sent once however often a message
// arrives (de-duplicated by the window's sequence number).
// OME-600 (W3b): the whole-room window is the same channel's other kind of window. Still one window per tab, whichever
// kind; a room window also gets what the stage draws (mirrored as it changes, so the page's renderer can pause), the
// picture's time for its plate, and each emote, and its seat clicks come back here to be sent.
import type { ClientMessage, EmoteKind, MemberId } from "@omega/shared";
import { CHAT_LOG_CAP, type ChatLogEntry } from "../chat/log";
import { chatIntent } from "../intents";
import type { StageState } from "../state";
import { parsePopMessage, type PopChannel, type PopKind, type PopState, type PopTv } from "./channel";

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
  /** Opens the pop-out window of that kind (window.open, noopener). */
  readonly openWindow: (kind: PopKind) => void;
  /** The chat (or the room) moved into the window, or another kind of window took over (true); it came back to the page (false). */
  readonly onPopped: (on: boolean) => void;
  /** A seat clicked in the room window: the page sits or stands (sitIntent) and sends it. */
  readonly onSeat: (seat: number) => void;
  readonly setTimer: (fn: () => void, ms: number) => H;
  readonly clearTimer: (h: H) => void;
}

export interface ChatRelay {
  popped(): boolean;
  /** Which window is adopted, if any. */
  kind(): PopKind | null;
  popOut(kind?: PopKind): void;
  bringBack(): void;
  /** A new chat log line (the page's log gets it too). */
  append(entry: ChatLogEntry): void;
  /** The room's chat state; posted when popped out and changed. */
  update(s: PopState): void;
  /** What the stage draws; posted to a room window when it changed. */
  view(s: StageState): void;
  /** The plate and my catching-up flag; posted to a room window when changed. */
  tv(t: PopTv): void;
  /** Someone emoted: a room window draws it. */
  emote(member: MemberId, kind: EmoteKind): void;
  /** "Show the window": ask the adopted window to come to the front. */
  raise(): void;
  /** The room tab is going away (pagehide). */
  close(): void;
  /** Back from the back/forward cache: the chat is home; a window still open says ready and is adopted again. */
  resume(): void;
}

const sameState = (a: PopState | null, b: PopState): boolean =>
  a !== null && a.title === b.title && a.people === b.people && a.cap === b.cap && a.open === b.open && a.cooling === b.cooling && a.muted === b.muted && a.placeholder === b.placeholder;

/** What the stage draws is the same: the same objects (the reducer keeps them when they don't change). */
const sameStage = (a: StageState | null, b: StageState): boolean =>
  a !== null && a.status === b.status && a.self === b.self && a.room === b.room && a.bubbles === b.bubbles && a.syslines === b.syslines && a.catching === b.catching;

const sameTv = (a: PopTv | null, b: PopTv): boolean =>
  a !== null && a.video === b.video && a.playing === b.playing && a.position === b.position && a.live === b.live && a.catching === b.catching;

export function createChatRelay<H>(o: ChatRelayOptions<H>): ChatRelay {
  const backlog: ChatLogEntry[] = [];
  let state: PopState | null = null;
  /** The last state the window was sent. */
  let posted: PopState | null = null;
  let stage: StageState | null = null;
  let postedStage: StageState | null = null;
  let tv: PopTv | null = null;
  let postedTv: PopTv | null = null;
  let active: string | null = null;
  let activeKind: PopKind | null = null;
  let lastSeq = -1;
  let lease: H | null = null;

  const renew = (): void => {
    if (lease !== null) o.clearTimer(lease);
    lease = active === null ? null : o.setTimer(() => {
      lease = null;
      // Silent that long and still open (throttled hard): tell it to go, so it isn't left open and unheard.
      o.channel.post({ t: "room-back" });
      release();
    }, POP_LEASE_MS);
  };

  const postState = (): void => {
    if (state === null || sameState(posted, state)) return;
    posted = state;
    o.channel.post({ t: "room-state", ...state });
  };
  const postStage = (): void => {
    if (activeKind !== "room" || stage === null || sameStage(postedStage, stage)) return;
    // Only the slice: the page's state has more (errors, the owner flag, …) that the window has no use for. The room
    // (25 members, the queue, the layout) only when it changed: the window keeps the one it has.
    const { status, self, room, bubbles, syslines, catching } = stage;
    const sameRoom = postedStage !== null && postedStage.room === room;
    postedStage = stage;
    o.channel.post(sameRoom ? { t: "room-view", status, self, bubbles, syslines, catching } : { t: "room-view", status, self, room, bubbles, syslines, catching });
  };
  const postTv = (): void => {
    if (activeKind !== "room" || tv === null || sameTv(postedTv, tv)) return;
    postedTv = tv;
    o.channel.post({ t: "room-tv", ...tv });
  };

  const release = (): void => {
    if (active === null) return;
    active = null;
    activeKind = null;
    posted = null;
    renew();
    o.onPopped(false);
  };

  const adopt = (pop: string, kind: PopKind): void => {
    const was = activeKind;
    active = pop;
    activeKind = kind;
    lastSeq = -1;
    posted = null;
    postedStage = null;
    postedTv = null;
    renew();
    o.channel.post({ t: "room-adopt", pop });
    o.channel.post({ t: "room-log", reset: true, entries: backlog.slice() });
    postState();
    postStage();
    postTv();
    if (was !== kind) o.onPopped(true);
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
        adopt(m.pop, m.kind ?? "chat");
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
      case "pop-sit":
        if (activeKind === "room" && fromActive(m.pop)) o.onSeat(m.seat);
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
      case "room-view":
      case "room-tv":
      case "room-emote":
      case "room-raise":
        return;
    }
  });
  o.channel.post({ t: "room-hello" });

  return {
    popped: () => active !== null,
    kind: () => activeKind,
    popOut(kind = "chat") {
      o.openWindow(kind);
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
    view(s) {
      stage = s;
      postStage();
    },
    tv(t) {
      tv = t;
      postTv();
    },
    emote(member, kind) {
      if (activeKind === "room") o.channel.post({ t: "room-emote", member, kind });
    },
    raise() {
      if (active !== null) o.channel.post({ t: "room-raise" });
    },
    close() {
      o.channel.post({ t: "room-gone" });
    },
    resume() {
      release();
      o.channel.post({ t: "room-hello" });
    },
  };
}
