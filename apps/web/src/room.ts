// Room screen. Loaded lazily after Enter so PixiJS stays out of the initial bundle.
import "pixi.js/unsafe-eval";
import { MAX_ROOM_MEMBERS, isSyncedEmbed, type AnyEmbed, type Avatar, type ClientMessage, type EmoteKind, type Embed, type ErrorCode, type MemberId, type Nickname, type RoomId, type RoomLayout } from "@omega/shared";
import { browserNow, createClockSync } from "./clock";
import { createConnection, type Connection, type SocketLike } from "./connection";
import { trackShareToken } from "./share-token";
import { routeConnectionEvent, type RoomEventSinks } from "./room-events";
import { forgetRoom, inviteLink, joinMessage, type RoomSecret, type SecretsStore } from "./room-secrets";
import { createInviteControl } from "./controls/invite";
import { createPersonal, createTransport, el, sprite } from "./controls/dom";
import { createPlaybackController, type PlaybackView } from "./controls/playback";
import { createQualityPicker } from "./controls/quality-picker";
import { qualityMemory } from "./controls/quality";
import { createQueuePanel } from "./controls/queue-panel";
import { chatView, kickedCard, refusalCard } from "./controls/feedback";
import { bouncedUntil, kickedUntil, rememberKick } from "./kick-memory";
import { mountErrorText, playerErrorText, providerHint } from "./controls/player-error";
import { chatIntent, sitIntent } from "./intents";
import { layoutOf } from "./furniture";
import { PHONE_QUERY, STAGE_H, STAGE_W, TAG_OFFSET_Y, WIDE_QUERY, fullscreenLayout, roomLayout, wideLayout, type Point, type Rect, type StripMode } from "./layout";
import { createFullscreen, type FullscreenMode } from "./fullscreen";
import { createRoomWindow } from "./room-window";
import type { PlayerError } from "./player/adapter";
import { PLAYERS, createPlayerMounter } from "./player/registry";
import { createStage, type Stage } from "./stage";
import { controlHeld, controlPolicy, initialState, nextExpiry, reduce, screen, type Refusal, type ViewEvent, type ViewState } from "./state";
import { genericFrame, tvFrame, type TvFrame } from "./tv";
import { createGenericTv } from "./controls/generic-tv";
import type { Editor } from "./editor/editor";
import type { Moderation } from "./owner/moderation";
import { createEmotePicker } from "./emote/picker";
import { createChatLog } from "./chat/log";
import { logEntries } from "./chat/feed";
import { chatKey } from "./chat/enter";
import { browserChannel, channelName, popoutSupported, popoutUrl, randomId, roomPopoutUrl, type PopState } from "./popout/channel";
import { createChatRelay, type ChatRelay } from "./popout/relay";
import { createReport } from "./report/dialog";

export interface RoomOptions {
  readonly root: HTMLElement;
  readonly roomId: RoomId;
  readonly socketUrl: string;
  readonly nickname: Nickname;
  readonly avatar: Avatar;
  /** This room's owner token and invite key from `omega.rooms`, if the browser holds any (ADR 0028). */
  readonly secret: RoomSecret | undefined;
  /** Where `omega.rooms` lives: a closed room is forgotten. */
  readonly secrets: SecretsStore;
  /** The site origin the invite link starts with. */
  readonly origin: string;
  /** The server's HTTP origin, for the owner's `DELETE /rooms/:id`. */
  readonly serverUrl: string;
}

export interface RoomHandle {
  readonly state: () => ViewState;
  readonly send: (msg: ClientMessage) => boolean;
  /** What the playback chrome shows (QA reads it in dev builds). */
  readonly playback: () => PlaybackView;
  /** The scene's draw order (room-view.ts `drawOrder`), for e2e depth checks. */
  readonly scene: () => string[];
  /** How many times the furniture was rebuilt for a new layout, for e2e "once per change" checks. */
  readonly layoutBuilds: () => number;
  /** A member's motion frame and emote sticker now (room-view.ts `frames`), for e2e emote checks. */
  readonly avatarFrames: (id: MemberId) => { avatar: string | null; sticker: string | null } | undefined;
  /** How many times the "Up next" rows were rebuilt, for e2e "once per queue change" checks. */
  readonly queueRenders: () => number;
  /** Is the room's render loop paused (full screen hides it, OME-597)? For e2e checks. */
  readonly roomPaused: () => boolean;
}

const STATUS_TEXT: Record<ViewState["status"], string> = {
  idle: "",
  connecting: "Connecting…",
  open: "",
  reconnecting: "Connection lost, reconnecting…",
  full: "",
  refused: "",
  closed: "",
  "taken-down": "",
  kicked: "",
};

const NOTICE_MS = 3000;
/** The full-screen strip's last open/collapsed state on this device (set k: "the strip remembers"). */
const STRIP_STORAGE_KEY = "omega.fsStrip";

function storedStrip(): StripMode {
  try {
    return localStorage.getItem(STRIP_STORAGE_KEY) === "band" ? "band" : "open";
  } catch {
    return "open";
  }
}

function storeStrip(mode: StripMode): void {
  try {
    localStorage.setItem(STRIP_STORAGE_KEY, mode);
  } catch {
    // Storage off (private mode): it's remembered for this page only.
  }
}

/** Typing somewhere: letters belong to the field, not to the page's keys. */
function typingIn(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);
}
const ERROR_TEXT: Record<ErrorCode, string> = {
  seat_taken: "Someone just took that seat.",
  rate_limited: "Slow down a little.",
  bad_message: "That didn't go through.",
  not_joined: "Still joining, try again in a moment.",
  already_joined: "You're already in this room.",
  no_embed: "That video isn't playing here any more.",
  nickname_taken: "Someone in this room already has that name.",
  too_many_members: "Too many people from your network are in this room.",
  invite_required: "This room is private. You need an invite link to join.",
  not_owner: "Only the room's owner can do that.",
  muted: "The room's owner muted your chat.",
  control_owner_only: "Only the room's owner can control the video here.",
  bad_target: "That person isn't in this room any more.",
  queue_full: "The queue is full. Remove one to add another.",
  unsupported_url: "That link can't be played in this room.",
};

/** Adapts the DOM WebSocket to the connection's SocketLike. */
function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const s: SocketLike = {
    send: (d) => {
      ws.send(d);
    },
    close: (code) => {
      ws.close(code);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => s.onopen?.();
  ws.onmessage = (ev: MessageEvent<unknown>) => s.onmessage?.({ data: ev.data });
  ws.onclose = (ev) => s.onclose?.({ code: ev.code });
  ws.onerror = () => s.onerror?.();
  return s;
}

/** A connection that never connects: a tab still inside its rejoin cooldown (kick-memory.ts). */
function stoppedConnection(): Connection {
  return { send: () => false, close: () => undefined, resume: () => undefined };
}

/** What the sync loop plays: the synced embed, or null (a generic embed is never synced, ADR 0024). */
function syncedOnly(e: AnyEmbed | null | undefined): Embed | null {
  return e != null && isSyncedEmbed(e) ? e : null;
}

/** The middle of the seats' bounding box (stage px): where the phone's room window looks first. */
function middleOf(points: readonly Point[]): Point {
  if (points.length === 0) return { x: STAGE_W / 2, y: STAGE_H / 2 };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

function box(e: HTMLElement, r: Rect): void {
  Object.assign(e.style, { left: `${String(r.x)}px`, top: `${String(r.y)}px`, width: `${String(r.w)}px`, height: `${String(r.h)}px` });
}

const KEYS = "button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, a[href], [tabindex]:not([tabindex='-1'])";
/** The first key in `root` someone could press now: shown, enabled and not inert. */
function firstKey(root: HTMLElement): HTMLElement | null {
  for (const e of root.querySelectorAll<HTMLElement>(KEYS)) if (e.checkVisibility() && e.closest("[inert]") === null) return e;
  return null;
}

export async function startRoom(opts: RoomOptions): Promise<RoomHandle> {
  const status = el("p", { className: "status", role: "status" }, "connection-status");
  // The title from the last rename (the snapshot carries none yet, OME-473). Text only.
  const title = el("h2", { className: "room-title", hidden: true }, "room-title");
  const notice = el("p", { className: "notice", role: "alert", hidden: true }, "room-notice");
  const full = el("div", { className: "room-full", hidden: true }, "room-full");
  full.append(el("h2", { textContent: "This room is full" }), el("p", { textContent: "Try again in a little while." }));
  // Refused join (nickname_taken, too_many_members, invite_required): the connection has stopped. Back to the landing to retry.
  const refused = el("div", { className: "room-full", hidden: true }, "room-refused");
  const refusedTitle = el("h2");
  const refusedBody = el("p");
  const refusedAction = el("a", { className: "enter", href: location.pathname }, "room-refused-action");
  refused.append(refusedTitle, refusedBody, refusedAction);
  let shownRefusal: Refusal | null = null;
  /** Whether the first answer from the server has been shown (and focus placed for a keyboard joiner, OME-701). */
  let landed = false;
  // 4004: the room was deleted or collected; 4006: the operators took it down after a report (ADR 0033 §6). The connection
  // has stopped; nothing here can bring it back.
  const closed = el("div", { className: "room-full", hidden: true }, "room-closed");
  const closedBody = el("p");
  const closedHome = el("a", { className: "enter", href: "/", textContent: "Go to the home page" });
  closed.append(el("h2", { textContent: "This room was closed" }), closedBody, closedHome);
  // "Report this room" (OME-601, ADR 0033): a guest's quiet key, the last stop of the room. Not made at all in a room you own.
  const report = opts.secret?.ownerToken === undefined ? createReport({ roomId: opts.roomId, serverUrl: opts.serverUrl, fetch: (url, init) => fetch(url, init), leave: () => { location.assign("/"); } }) : null;
  const foot = el("div", { className: "room-foot", hidden: true }, "room-foot");
  if (report !== null) foot.append(report.key, report.dialog);
  // 4005: the owner removed us (ADR 0030). The connection has stopped; Rejoin waits out the cooldown, then reloads.
  const kicked = el("div", { className: "room-full", hidden: true }, "room-kicked");
  const kickedTitle = el("h2");
  const kickedBody = el("p");
  const rejoinIcon = el("span", { className: "ui-sprite ui-wait", ariaHidden: "true" });
  const rejoinText = el("span");
  const rejoin = el("button", { type: "button", className: "ui-button" }, "room-kicked-rejoin");
  rejoin.append(rejoinIcon, rejoinText);
  rejoin.addEventListener("click", () => {
    if (rejoin.getAttribute("aria-disabled") !== "true") location.reload();
  });
  kicked.append(
    el("span", { className: "ui-scene ui-scene-removed", ariaHidden: "true" }),
    kickedTitle,
    kickedBody,
    rejoin,
    el("a", { className: "enter secondary", href: "/", textContent: "Find a room" }),
  );
  let kickedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fill the card for now and re-arm for the next minute; once the cooldown is over Rejoin is a plain key. */
  const renderKicked = (until: number | null): void => {
    if (kickedTimer !== null) clearTimeout(kickedTimer);
    kickedTimer = null;
    const card = kickedCard(until, Date.now());
    kickedTitle.textContent = card.title;
    kickedBody.textContent = card.body;
    rejoinText.textContent = card.rejoin;
    rejoin.classList.toggle("is-waiting", !card.ready);
    rejoinIcon.hidden = card.ready;
    if (card.ready) rejoin.removeAttribute("aria-disabled");
    else rejoin.setAttribute("aria-disabled", "true");
    // The dial runs once over what's left of the cooldown (set f's .ui-wait).
    if (until !== null) rejoinIcon.style.setProperty("--cool", `${String(Math.max(0, until - Date.now()))}ms`);
    if (card.nextChangeMs !== null) kickedTimer = setTimeout(() => { renderKicked(until); }, card.nextChangeMs);
  };
  const writeText = (t: string): Promise<void> => ("clipboard" in navigator ? navigator.clipboard.writeText(t) : Promise.reject(new Error("no clipboard")));
  const invite = createInviteControl(inviteLink(opts.origin, opts.roomId, opts.secret?.inviteKey), opts.secret?.inviteKey !== undefined, writeText);
  invite.hidden = true;

  // The TV and its control bar sit above the scaled stage, unscaled, so the player keeps
  // YouTube's minimum size and no room layer can stack over it (layout.ts `roomLayout`).
  // Under prefers-reduced-motion an emote is a static badge over the avatar instead of an animation (OME-415).
  const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
  const roomStage: Stage = await createStage({
    reducedMotion,
    requestRender: () => {
      requestRender();
    },
    onLayout: (points) => {
      seatsMiddle = middleOf(points);
      if (phone.matches) fit();
    },
  });
  const { root: stage, overlay, tags, view } = roomStage;
  const clip = el("div", { className: "stage-clip" }, "room-window");
  clip.append(stage);
  const tv = el("div", { className: "tv ui-tv-frame" }, "tv");
  const controls = el("div", { className: "controls ui-tv-shelf" });
  // The full-screen element (OME-597): an existing ancestor of the TV, so going full screen moves no node and the
  // provider's iframe never reloads.
  const wrap = el("div", { className: "stage-wrap", hidden: true }, "fs-root");
  wrap.append(tv, controls, clip);
  const tvEmpty = el("p", { className: "tv-empty", textContent: "Share a video with the extension, or paste a link under Up next, to watch it here." });
  tv.append(tvEmpty);
  const syncNotice = el("p", { className: "notice sync-notice", role: "status", hidden: true }, "sync-notice");
  const tvHint = el("p", { className: "notice tv-hint", hidden: true }, "tv-hint");

  const chatForm = el("form", { className: "chat" });
  const chatInput = el("input", { type: "text", maxLength: 280, placeholder: "Say something…", autocomplete: "off", ariaLabel: "Chat message" }, "chat-input");
  const chatSend = el("button", { type: "submit", textContent: "Say" }, "chat-send");
  // The emote key and its picker (OME-415) lead the chat row: both are how you speak up.
  const picker = createEmotePicker({
    send: (m) => send(m),
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  });
  // Pop-out chat (OME-598, set k): the key ends the chat row; while the chat is in its window the row's place holds the
  // set (k) placeholder with a bring-back key. Desktop only, and only where BroadcastChannel exists.
  const popKey = el("button", { type: "button", className: "ui-button self icon", ariaLabel: "Pop out chat", title: "Pop out chat" }, "chat-popout");
  popKey.append(sprite("ui-icon-popout"));
  const popOut = el("span", { className: "pop-out", hidden: true });
  popOut.append(popKey);
  chatForm.append(picker.root, chatInput, chatSend, popOut);
  const chatAway = el("div", { className: "ui-panel ui-away chat-away", role: "status", hidden: true }, "chat-away");
  const chatAwayText = el("p");
  chatAwayText.append(el("b", { textContent: "Chat is in its own window." }), el("br"), "Bubbles still show over the avatars here.");
  const bringBack = el("button", { type: "button", className: "ui-button self" }, "chat-bring-back");
  bringBack.append(sprite("ui-icon-popout-back"), "Bring chat back");
  chatAway.append(el("span", { className: "ui-sprite ui-scene ui-scene-chat-away", ariaHidden: "true" }), chatAwayText, bringBack);
  // Pop-out room (OME-600, set k): the key is in the room's top bar (never beside "Pop out chat"); while the room is in its
  // window the stage's place holds the set (k) placeholder, the page keeps the picture and the one socket, and its own
  // renderer is paused (never two running).
  const roomTop = el("div", { className: "room-top" });
  const popRoomKey = el("button", { type: "button", className: "ui-button self icon", ariaLabel: "Pop out room", title: "Pop out room", hidden: true }, "room-popout");
  popRoomKey.append(sprite("ui-icon-popout-room"));
  roomTop.append(title, popRoomKey);
  const roomAway = el("div", { className: "ui-panel ui-away room-away", role: "status", hidden: true }, "room-away");
  const roomAwayText = el("p");
  roomAwayText.append(el("b", { textContent: "The room is in its own window." }), el("br"), "The picture stays here; the room and chat are over there.");
  const roomBack = el("button", { type: "button", className: "ui-button self" }, "room-bring-back");
  roomBack.append(sprite("ui-icon-popout-room-back"), "Bring the room back");
  const showWindow = el("button", { type: "button", className: "ui-button secondary", textContent: "Show the window" }, "room-show-window");
  const roomAwayKeys = el("div", { className: "room-away-keys" });
  roomAwayKeys.append(roomBack, showWindow);
  roomAway.append(el("span", { className: "ui-sprite ui-scene ui-scene-room-away", ariaHidden: "true" }), roomAwayText, roomAwayKeys);
  // The chat log (OME-594): the same component moves into the full-screen strip (W2) and the pop-out (W3).
  const chatLog = createChatLog({
    ageing: "settle",
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h);
    },
  });

  // Full screen (OME-597, set k `ui-m7-desktop` / `ui-m7-band`). The key ends the shelf (a personal key: it changes only
  // your screen). The strip is the TV cabinet's side panel: while full screen lasts the chat log (fading) and the field
  // move into it, beside the picture or under it, or it collapses to the field on one band under the picture.
  const fsKey = el("button", { type: "button", className: "ui-button self icon fs-key", ariaLabel: "Full screen" }, "fullscreen-toggle");
  fsKey.setAttribute("aria-keyshortcuts", "F");
  const fsIcon = sprite("ui-icon-fullscreen");
  fsKey.append(fsIcon);
  const strip = el("aside", { className: "fs-strip ui-fs-strip", ariaLabel: "Chat", hidden: true }, "fs-strip");
  const stripHead = el("div", { className: "fs-strip-head" });
  const stripToggle = el("button", { type: "button", className: "ui-button self icon" }, "fs-strip-toggle");
  const stripIcon = sprite("ui-icon-strip-hide");
  stripToggle.append(stripIcon);
  // Mustard: only your own count of what you missed while collapsed; the key's label says it too.
  const unreadChip = el("span", { className: "ui-chip self fs-unread", ariaHidden: "true", hidden: true });
  stripHead.append(sprite("ui-icon-chat"), el("span", { className: "fs-strip-title", textContent: "Chat" }));
  strip.append(stripHead);
  wrap.append(strip);
  let stripMode: StripMode = storedStrip();
  let unread = 0;
  const renderStrip = (): void => {
    const open = stripMode === "open";
    strip.dataset["strip"] = stripMode;
    stripToggle.ariaExpanded = String(open);
    stripToggle.ariaLabel = open ? "Collapse chat to the input bar" : unread > 0 ? `Show chat, ${String(unread)} new message${unread === 1 ? "" : "s"}` : "Show chat";
    stripIcon.className = `ui-sprite ${open ? "ui-icon-strip-hide" : "ui-icon-strip-show"}`;
    unreadChip.textContent = `${String(unread)} new`;
    unreadChip.hidden = open || unread === 0;
    // Collapsed in full screen the log is out of sight: no invisible tab stop.
    chatLog.root.tabIndex = !open && !strip.hidden ? -1 : 0;
    // Open, the key heads the strip; collapsed, it follows the field on the band. Focus stays on it either way.
    const home = open ? stripHead : strip;
    if (stripToggle.parentElement !== home || home.lastElementChild !== unreadChip) {
      const focused = document.activeElement === stripToggle;
      home.append(stripToggle, unreadChip);
      if (focused) stripToggle.focus({ preventScroll: true });
    }
  };
  stripToggle.addEventListener("click", () => {
    stripMode = stripMode === "open" ? "band" : "open";
    unread = 0;
    storeStrip(stripMode);
    renderStrip();
    fit();
  });
  renderStrip();

  let state = initialState;
  let conn: Connection | null = null;
  const send = (m: ClientMessage): boolean => conn?.send(m) ?? false;
  // connection → clock → sync loop → player (ADR 0011). One 4 Hz timer drives the clock tick, the loop and the chrome.
  const clock = createClockSync({
    now: browserNow,
    sendPing: (id) => send({ type: "ping", id }),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h);
    },
    window,
    document,
  });
  let pbView: PlaybackView | null = null;
  let shownPlayerError: PlayerError | null = null;
  let ctlFrame = 0;
  const playback = createPlaybackController({
    send,
    clock,
    now: () => performance.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => {
      clearInterval(h);
    },
    onView: (v) => {
      pbView = v;
      // The room window's plate and my hourglass there: from the player's timer, not a frame (a hidden tab draws none).
      relay?.tv({ video: v.hasVideo, playing: v.playing, position: Math.max(0, Math.floor(v.position)), live: v.live, catching: v.catching });
      if (ctlFrame === 0) ctlFrame = requestAnimationFrame(renderControls);
    },
    // This device's quality per provider (OME-599). The `localStorage` getter itself throws when storage is blocked.
    qualityMemory: qualityMemory({
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => {
        localStorage.setItem(k, v);
      },
    }),
  });
  const transport = createTransport(playback);
  const personal = createPersonal(playback);
  // Quality, only you (OME-599, set k `ui-m7-quality`): a key before full screen, only where the player can be set.
  const quality = createQualityPicker(playback, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => {
      clearTimeout(h);
    },
  });
  /** The synced tier's shelf. The volume pod rides in it, right under the picture (OME-642): you reach for it while you watch. */
  const syncShelf = (): void => {
    controls.replaceChildren(transport.root, personal.pod, quality.key, fsKey);
  };
  syncShelf();
  /** In the page the list hangs under the shelf, over the room (ours), its tail on the key; never over the picture. */
  const placeQuality = (): void => {
    if (!quality.isOpen() || quality.menu.parentElement !== wrap) return;
    const m = quality.menu;
    const k = quality.key;
    const right = controls.offsetLeft + k.offsetLeft + k.offsetWidth / 2;
    const left = Math.max(0, right - m.offsetWidth + 24);
    m.style.left = `${String(left)}px`;
    m.style.top = `${String(controls.offsetTop + controls.offsetHeight + 8)}px`;
    m.style.setProperty("--ui-tail-x", `${String(right - left)}px`);
  };
  quality.onToggle((open) => {
    // Full screen: the list takes the shelf's place, so nothing grows over the picture.
    const row = fs.mode() !== "off";
    controls.classList.toggle("is-quality-row", open && row);
    if (!open) {
      quality.menu.remove();
      return;
    }
    if (row) controls.append(quality.menu);
    else {
      wrap.append(quality.menu);
      placeQuality();
    }
  });
  // "Up next" (ADR 0031): the room's queue under the TV. Its rows are text; it redraws only when the queue changes.
  const queuePanel = createQueuePanel({ send, ownHosts: [location.hostname] });

  // The provider hint sits right above the TV, next to what it's about (OME-251): below the stage it's off-screen.
  // The owner's "Edit room" key (set (h)): made only for the owner, and the editor chunk loads only when it's pressed.
  const editBar = el("div", { className: "edit-bar" });
  const editorPanel = el("div", { className: "editor-panel" });
  // Set (k) phone watch layout (OME-596): TV full width, the room at 1× in a window you drag, chat right under it, no editor.
  const phone = globalThis.matchMedia(PHONE_QUERY);
  // Desktop wide layout (OME-642): the room on the left, the chat and Up next in a full-height column on the right.
  const wide = globalThis.matchMedia(WIDE_QUERY);
  const side = el("div", { className: "room-side", hidden: true }, "room-side");
  const fs = createFullscreen({
    target: wrap,
    isTarget: (e) => e === wrap,
    document,
    history,
    window,
    orientation: globalThis.screen.orientation,
    onChange: (mode) => {
      onFullscreen(mode);
    },
  });
  fsKey.addEventListener("click", () => {
    void fs.toggle();
  });
  /** In full screen the room is hidden and stops drawing; the log and field move into the strip and back. */
  /**
   * The CSS mode covers the page but doesn't take it away: make everything beside the wrapper and its ancestors inert
   * (no tab stops, out of the accessibility tree), as element full screen does, and give it back on the way out.
   */
  let inertBehind: HTMLElement[] = [];
  const setBehindInert = (on: boolean): void => {
    for (const e of inertBehind) e.inert = false;
    inertBehind = [];
    if (!on) return;
    for (let node: HTMLElement = wrap; node.parentElement !== null && node !== document.body; node = node.parentElement) {
      for (const sib of node.parentElement.children) {
        if (sib === node || !(sib instanceof HTMLElement) || sib.inert) continue;
        sib.inert = true;
        inertBehind.push(sib);
      }
    }
  };
  /** Where focus was before full screen, if full screen hid it (a seat in the room): it goes back there on the way out. */
  let focusBefore: HTMLElement | null = null;
  const onFullscreen = (mode: FullscreenMode): void => {
    const on = mode !== "off";
    // Moving a focused field blurs it: give focus back to where it was (the draft is the same node, so it stays).
    const focused = document.activeElement;
    const wasInRoom = on && focused instanceof HTMLElement && clip.contains(focused);
    const restoreScroll = holdScroll();
    wrap.classList.toggle("is-fs", on);
    wrap.classList.toggle("is-pseudo-fs", mode === "pseudo");
    // The quality list is a row in full screen, a tray under the shelf in the page: it closes as the layout changes.
    quality.setRow(on);
    renderRoomPlace();
    fsKey.ariaLabel = on ? "Exit full screen" : "Full screen";
    fsIcon.className = `ui-sprite ${on ? "ui-icon-fullscreen-exit" : "ui-icon-fullscreen"}`;
    unread = 0;
    chatLog.setAgeing(on ? "fade" : "settle");
    placeChat();
    setBehindInert(mode === "pseudo");
    renderStrip();
    fit();
    restoreScroll();
    // The chat moves back out of the strip, but the strip's own key stays in it and the strip hides (OME-701).
    const stranded = !on && focused instanceof HTMLElement && strip.contains(focused);
    if (wasInRoom) {
      // The room is hidden now: the key you pressed to enter (or the exit key, for F) holds focus meanwhile.
      focusBefore = focused;
      fsKey.focus({ preventScroll: true });
    } else if (!on && focusBefore !== null && (stranded || document.activeElement === fsKey || document.activeElement === document.body)) {
      const back = focusBefore;
      focusBefore = null;
      (back.isConnected ? back : fsKey).focus({ preventScroll: true });
    } else if (stranded) fsKey.focus({ preventScroll: true });
    else if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    if (!on) focusBefore = null;
  };
  opts.root.replaceChildren(roomTop, status, tvHint, wrap, roomAway, editBar, editorPanel, personal.root, queuePanel.root, syncNotice, notice, chatLog.root, chatForm, invite, full, refused, closed, kicked, side, foot);
  /**
   * Moving a scrolled box resets its scroll (QA OME-658): call before a move and the returned function after the layout
   * settles. A log at its foot goes back to its foot (so it keeps following new lines); otherwise it keeps its place.
   */
  const holdScroll = (): (() => void) => {
    const held = [chatLog.root, queuePanel.root].map((e) => ({ e, top: e.scrollTop, foot: e.scrollHeight - e.scrollTop - e.clientHeight <= 2 }));
    return () => {
      for (const h of held) h.e.scrollTop = h.foot ? h.e.scrollHeight : h.top;
    };
  };
  /** On a phone the chat follows the room straight away, on screen and in focus order; elsewhere it's under the notices. */
  const placeChat = (): void => {
    const two = wide.matches;
    opts.root.classList.toggle("room-wide", two);
    side.hidden = !two;
    // Wide: the room's placeholder, the invite and Up next head the chat column; otherwise they're back in the page's flow.
    if (two) side.prepend(roomAway, invite, queuePanel.root);
    else {
      wrap.after(roomAway);
      notice.after(invite);
      personal.root.after(queuePanel.root);
    }
    if (fs.mode() !== "off") stripHead.after(chatLog.root, chatForm, chatAway);
    else if (two) side.append(chatLog.root, chatForm, chatAway);
    else if (phone.matches) wrap.after(chatLog.root, chatForm, chatAway);
    else notice.after(chatLog.root, chatForm, chatAway);
    // Set (k): every key and field is at least 44×44 CSS px to the finger (reference.css .ui-touch).
    opts.root.classList.toggle("ui-touch", phone.matches);
  };
  placeChat();

  /** The room tab's end of the pop-out chat; null where BroadcastChannel is missing. Made once the socket exists. */
  let relay: ChatRelay | null = null;
  let popped = false;
  /** The whole room is in the window (OME-600): the page shows the picture only. */
  const roomOut = (): boolean => popped && relay?.kind() === "room";
  /** The shown embed's provider: Twitch needs a larger TV (layout.ts). */
  let tvProvider: Embed["provider"] | null = null;
  /** The phone's window looks at the middle of the seats until you drag it, sit, or focus something off-screen. */
  const roomWindow = createRoomWindow(clip, stage, () => seatsMiddle);
  let seatsMiddle: Point = { x: STAGE_W / 2, y: STAGE_H / 2 };
  const fit = (): void => {
    if (fs.mode() !== "off") {
      // The room popped out: its chat is in the window, so the picture is alone.
      const l = fullscreenLayout(wrap.clientWidth, wrap.clientHeight, tvProvider, roomOut() ? "none" : stripMode);
      box(tv, l.tv);
      box(controls, l.controls);
      box(strip, l.strip);
      strip.dataset["at"] = l.at;
      tv.classList.toggle("compact", l.compact.tv);
      controls.classList.toggle("compact", l.compact.controls);
      wrap.style.height = "";
      return;
    }
    if (wide.matches) {
      // The left column's box sizes it all (the wrap flexes to what the column has left), so the page never scrolls.
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      // The room popped out: the picture has the column (its placeholder is in the chat column).
      const l = roomOut() ? fullscreenLayout(w, h, tvProvider, "none") : wideLayout(w, h, tvProvider);
      box(tv, l.tv);
      box(controls, l.controls);
      tv.classList.toggle("compact", l.compact.tv);
      controls.classList.toggle("compact", l.compact.controls);
      if ("stage" in l) {
        box(clip, l.stage);
        roomWindow.set(false, 0, 0);
        stage.style.transform = `scale(${String(l.scale)})`;
      }
      wrap.style.height = "";
      return;
    }
    const onPhone = phone.matches;
    const l = roomLayout(wrap.clientWidth, tvProvider, onPhone);
    box(tv, l.tv);
    box(controls, l.controls);
    tv.classList.toggle("compact", l.compact.tv);
    controls.classList.toggle("compact", l.compact.controls);
    box(clip, l.stage);
    if (onPhone) roomWindow.set(true, l.stage.w, l.stage.h);
    else {
      roomWindow.set(false, 0, 0);
      stage.style.transform = `scale(${String(l.scale)})`;
    }
    // The room popped out: the wrap ends where the stage would start, and the placeholder follows it.
    wrap.style.height = `${String(roomOut() ? l.stage.y : l.height)}px`;
  };
  /** Layout first, then the open quality tray follows its key. */
  const relayout = (): void => {
    fit();
    placeQuality();
  };
  new ResizeObserver(relayout).observe(wrap);
  fit();

  let frame = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let tvKey: string | null = null;
  /** The owner's unsaved draft, shown to them instead of the room's layout while they edit. */
  let preview: RoomLayout | null = null;
  let editToggle: HTMLButtonElement | null = null;
  let editor: Editor | null = null;
  /** Bumped on each open/close, so a slow chunk load for an editor that was closed meanwhile is dropped. */
  let editorGen = 0;
  let shownError: ViewState["lastError"] = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  function renderControls(): void {
    ctlFrame = 0;
    const v = pbView;
    if (v === null) return;
    transport.update(v);
    personal.update(v);
    quality.update(v);
    roomStage.applyCatching(state, v.catching);
    if (v.error !== shownPlayerError) {
      shownPlayerError = v.error;
      // The only other sync notice (API didn't load) never has a player, so there's no error to clash with.
      syncNotice.textContent = v.error === null ? "" : playerErrorText(v.error);
      syncNotice.hidden = v.error === null;
    }
  }

  const mount = createPlayerMounter(PLAYERS);
  /** What the TV shows now: the iframe we built, or the container a provider SDK renders into. */
  let tvScreen: HTMLElement | null = null;
  const mountPlayer = (embed: Embed, frame: TvFrame, screenEl: HTMLElement, iframe: HTMLIFrameElement | null): void => {
    syncNotice.hidden = true;
    // Only the shown embed's provider module and SDK load, and only now (ADR 0014, research §5).
    // mount() never rejects (registry.ts).
    void mount({ embed, frame, target: { iframe, container: screenEl }, now: () => performance.now() }).then((r) => {
      if (tvScreen !== screenEl) {
        if (r.ok) r.player.destroy();
        return;
      }
      if (!r.ok) {
        syncNotice.textContent = mountErrorText(embed.provider, r.reason);
        syncNotice.hidden = false;
        return;
      }
      playback.attach(r.player, embed.url);
    });
  };

  const requestRender = (): void => {
    if (frame === 0) frame = requestAnimationFrame(render);
  };

  const closeEditor = (): void => {
    editorGen++;
    editor?.destroy();
    editor = null;
    preview = null;
    if (editToggle !== null) {
      editToggle.ariaPressed = "false";
      editToggle.lastChild?.replaceWith("Edit room");
    }
    requestRender();
  };

  const openEditor = (toggle: HTMLButtonElement, ownerToken: NonNullable<RoomSecret["ownerToken"]>): void => {
    const gen = ++editorGen;
    toggle.ariaPressed = "true";
    toggle.lastChild?.replaceWith("Done");
    void import("./editor/editor")
      .then(({ mountEditor }) =>
        mountEditor({
          panel: editorPanel,
          stage,
          view,
          saved: () => layoutOf(state.room),
          title: () => state.title,
          preview: (l) => {
            preview = l;
            requestRender();
          },
          send,
          roomId: opts.roomId,
          serverUrl: opts.serverUrl,
          ownerToken,
          fetch: (url, init) => fetch(url, init),
          alive: () => gen === editorGen,
        }),
      )
      .then((e) => {
        if (gen !== editorGen) e.destroy();
        else editor = e;
      })
      .catch((e: unknown) => {
        console.warn("editor failed to load", e);
        if (gen === editorGen) closeEditor();
      });
  };

  let moderation: Moderation | null = null;
  /** Bumped when the tools go, so a chunk that loads after that is dropped. */
  let moderationGen = 0;
  /** The chunk failed to load: don't retry on every render (a reload tries again). */
  let moderationFailed = false;
  /** The owner's moderation tools (ADR 0030): their own lazy chunk, loaded only on an owner's page. */
  const renderModeration = (s: ViewState): void => {
    const want = s.owner && opts.secret?.ownerToken !== undefined && screen(s).stage;
    if (!want) {
      if (moderationGen % 2 === 1) {
        moderationGen++;
        moderation?.destroy();
        moderation = null;
      }
      return;
    }
    if (moderation !== null) {
      moderation.update();
      return;
    }
    if (moderationGen % 2 === 1 || moderationFailed) return;
    const gen = ++moderationGen;
    void import("./owner/moderation")
      .then(({ mountModeration }) => {
        if (gen !== moderationGen) return;
        moderation = mountModeration({ stage, tags, bar: editBar, view: () => state, send, stageWidth: STAGE_W, anchor: (id) => {
          const p = roomStage.anchor(id);
          return p === undefined ? undefined : { x: p.x, y: p.y + TAG_OFFSET_Y };
        } });
        moderation.update();
      })
      .catch((e: unknown) => {
        console.warn("moderation tools failed to load", e);
        moderationFailed = true;
        if (gen === moderationGen) moderationGen++;
      });
  };

  /** Said once per page, the first time an owner is in their open room on a phone. */
  let arrangeHinted = false;
  /** Only the owner, in an open room, gets the key; it isn't in the DOM for anyone else. Never on a phone (set k). */
  const renderEditToggle = (s: ViewState): void => {
    const ownerToken = opts.secret?.ownerToken;
    const owns = s.owner && ownerToken !== undefined && screen(s).stage;
    if (owns && phone.matches && !arrangeHinted && s.status === "open") {
      arrangeHinted = true;
      chatLog.append({ kind: "system", line: { glyph: "host", actor: null, verb: "Arrange the room on a computer.", time: null, self: true } });
    }
    const want = owns && !phone.matches && !roomOut();
    if (!want) {
      if (editToggle !== null) {
        closeEditor();
        editToggle.remove();
        editToggle = null;
      }
      return;
    }
    if (editToggle !== null) {
      editToggle.disabled = s.status !== "open";
      return;
    }
    const b = el("button", { type: "button", className: "ui-button self" }, "edit-room");
    b.ariaPressed = "false";
    b.append(el("span", { className: "ui-sprite ui-icon-arrange", ariaHidden: "true" }), "Edit room");
    b.addEventListener("click", () => {
      if (editor !== null || b.ariaPressed === "true") closeEditor();
      else openEditor(b, ownerToken);
    });
    editBar.append(b);
    editToggle = b;
  };

  /** The seat the phone's window last centred on, so it follows me when I sit, and only then. */
  let centredSeat = -1;
  /** The stage's place: the room (paused in full screen or while it's in its window) or the placeholder. */
  const renderRoomPlace = (): void => {
    const on = fs.mode() !== "off";
    const out = roomOut();
    clip.hidden = on || out;
    view.setPaused(on || out);
    strip.hidden = !on || out;
    roomAway.hidden = !out;
    popRoomKey.hidden = out || !screen(state).stage || !popoutSupported({ hasChannel: relay !== null, phone: phone.matches });
  };
  /** The chat row's place: the log and the field, or (popped out) the placeholder; the pop-out key only where it works. */
  const renderChatRow = (s: ViewState): void => {
    const shown = screen(s);
    // Removed, closed or full: nothing to say any more, so the chat comes home (the log stays above a removal's card).
    if (popped && !shown.chat) relay?.bringBack();
    chatForm.hidden = !shown.chat || popped;
    // Removed (ADR 0030): the log stays up above the card, ending with the only-you line.
    chatLog.root.hidden = (!shown.chat && !shown.kicked) || popped;
    // The room's window holds the chat too: the room's placeholder says so.
    chatAway.hidden = !popped || roomOut();
    popOut.hidden = !popoutSupported({ hasChannel: relay !== null, phone: phone.matches });
    renderRoomPlace();
  };
  /** What the pop-out window shows of the room: the head count, and whether (and why not) it may send. */
  const popState = (s: ViewState): PopState => {
    const chat = chatView(s, Date.now());
    return { title: s.title, people: s.room?.members.length ?? 0, cap: MAX_ROOM_MEMBERS, open: screen(s).chat, cooling: chat.cooling, muted: chat.muted, placeholder: chat.placeholder };
  };
  /** The room was out when the relay last said: it changes its kind before it tells us, so we keep our own. */
  let wasRoomOut = false;
  const onPopped = (on: boolean): void => {
    const focused = document.activeElement;
    popped = on;
    const out = roomOut();
    const wasOut = wasRoomOut;
    wasRoomOut = out;
    // The editor draws on the stage, which is in the window now.
    if (out) closeEditor();
    renderChatRow(state);
    renderEditToggle(state);
    fit();
    if (on) {
      relay?.update(popState(state));
      relay?.view(state);
      // What went away was under focus: the bring-back key is the first stop in its place.
      const gone = focused instanceof HTMLElement && (chatForm.contains(focused) || (out && (focused === popRoomKey || clip.contains(focused) || chatAway.contains(focused))));
      if (gone) (out ? roomBack : bringBack).focus({ preventScroll: true });
    } else if (focused === null || focused === document.body || chatAway.contains(focused) || roomAway.contains(focused)) {
      // Set k: the chat row returns in place with focus in the message field.
      chatInput.focus({ preventScroll: true });
    }
    // Back from the window: draw the room once as it is now (it drew nothing while it was out).
    if (wasOut && !out) requestRender();
  };

  const render = (): void => {
    frame = 0;
    const s = state;
    // The stage first: it rebuilds the seats for a new layout before anything reads them. Out in its window, the room
    // is drawn there, not here.
    if (!roomOut()) roomStage.render(s, preview ?? layoutOf(s.room), pbView?.catching === true);
    const mySeat = s.self === null ? -1 : (s.room?.seats.indexOf(s.self) ?? -1);
    if (mySeat !== centredSeat) {
      centredSeat = mySeat;
      const p = roomStage.seat(mySeat);
      if (p !== undefined) roomWindow.centre(p);
    }
    if (title.textContent !== (s.title ?? "")) title.textContent = s.title ?? "";
    title.hidden = s.title === null;
    renderEditToggle(s);
    editor?.update();
    status.textContent = STATUS_TEXT[s.status];
    const shown = screen(s);
    wrap.hidden = !shown.stage;
    // Removed, closed or full: no picture to watch any more.
    if (!shown.stage && fs.mode() !== "off") fs.exit();
    renderChatRow(s);
    full.hidden = !shown.full;
    refused.hidden = shown.refused === null;
    invite.hidden = !shown.stage;
    queuePanel.root.hidden = !shown.stage;
    queuePanel.update(s);
    if (kicked.hidden === shown.kicked) {
      kicked.hidden = !shown.kicked;
      if (shown.kicked) renderKicked(s.kickedUntil);
    }
    const isClosed = shown.closed !== false;
    if (closed.hidden === isClosed) {
      closed.hidden = !isClosed;
      if (shown.closed !== false) {
        closed.dataset["reason"] = shown.closed;
        closedBody.textContent = shown.closed === "taken-down" ? "This room was closed by the omega-share team after a report." : "Its owner deleted it, or nobody used it for a long time.";
        forgetRoom(opts.secrets, opts.roomId);
      }
    }
    // Nothing left to report once the room is gone, and an owner never reports their own room.
    const footShown = report !== null && !isClosed && !s.owner;
    if (foot.hidden === footShown) {
      foot.hidden = !footShown;
      if (!footShown && report?.isOpen() === true) {
        report.close();
        // The key went with the foot: focus moves to the card in its place, not to <body> (QA OME-640).
        if (isClosed) closedHome.focus({ preventScroll: true });
      }
    }
    if (shown.refused !== shownRefusal) {
      shownRefusal = shown.refused;
      if (shown.refused !== null) {
        const card = refusalCard(shown.refused);
        refusedTitle.textContent = card.title;
        refusedBody.textContent = card.body;
        refusedAction.textContent = card.action;
        refused.dataset["code"] = shown.refused;
      }
    }
    const chat = chatView(s, Date.now());
    chatForm.dataset["cooldown"] = String(chat.cooling);
    chatSend.disabled = chat.cooling;
    // Muted by the host (ADR 0030, set j): a read-only well that says why. Emotes still work.
    chatInput.readOnly = chat.muted;
    chatInput.classList.toggle("is-muted", chat.muted);
    chatForm.dataset["muted"] = String(chat.muted);
    // Set k (OME-642): with a keyboard, the open field says how to reach it.
    const hint = chat.cooling || phone.matches ? chat.placeholder : "Press Enter to chat";
    if (chatInput.placeholder !== hint) chatInput.placeholder = hint;

    if (s.lastError !== shownError) {
      shownError = s.lastError;
      if (s.lastError !== null) {
        notice.textContent = ERROR_TEXT[s.lastError.code];
        notice.hidden = false;
        if (noticeTimer !== null) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
          notice.hidden = true;
        }, NOTICE_MS);
      }
    }

    renderModeration(s);
    // The landing form held focus and is gone: once the room (or the card in its place) shows, its first key takes it.
    if (!landed && s.status !== "idle" && s.status !== "connecting") {
      landed = true;
      const a = document.activeElement;
      if (a === null || a === document.body || (a instanceof HTMLElement && !a.checkVisibility())) firstKey(opts.root)?.focus({ preventScroll: true });
    }
  };

  /**
   * Swap the TV iframe with the embed. Runs from dispatch, not the next frame: rAF doesn't fire in a
   * background tab, and the old video must not keep playing (unsynced) after the controller dropped it.
   */
  const syncTv = (s: ViewState): void => {
    const any = s.room?.embed ?? null;
    if (any !== null && !isSyncedEmbed(any)) {
      showGeneric(any, s.room?.itemId);
      return;
    }
    const embed = syncedOnly(any);
    const tf = tvFrame(embed);
    const nextKey = tf?.key ?? null;
    if (nextKey !== tvKey) {
      tvKey = nextKey;
      showSyncChrome(true);
      const provider = tf === null ? null : (embed?.provider ?? null);
      if (provider !== tvProvider) {
        tvProvider = provider;
        const hint = provider === null ? null : providerHint(provider);
        tvHint.textContent = hint ?? "";
        tvHint.hidden = hint === null;
        fit();
      }
      if (tf === null || embed === null) {
        tvScreen = null;
        tv.replaceChildren(tvEmpty);
      } else if (tf.kind === "iframe") {
        const iframe = el("iframe", { src: tf.src, allow: tf.allow, referrerPolicy: tf.referrerPolicy, title: "Shared video" }, "shared-video");
        iframe.setAttribute("sandbox", tf.sandbox);
        tvScreen = iframe;
        tv.replaceChildren(iframe);
        mountPlayer(embed, tf, iframe, iframe);
      } else {
        // The Twitch SDK builds its own iframe inside a fresh container; its adapter checks the result (ADR 0014 §5).
        const box = el("div", { className: "tv-sdk" }, "shared-video");
        tvScreen = box;
        tv.replaceChildren(box);
        mountPlayer(embed, tf, box, null);
      }
    }
  };

  /** The sync controls and your volume belong to the synced tier; the generic tier's strip takes their slot. */
  const showSyncChrome = (synced: boolean): void => {
    // The whole synced shelf, the volume pod too (after a generic item the strip had its slot).
    if (synced && controls.firstChild !== transport.root) syncShelf();
    personal.root.hidden = !synced;
  };

  /** A generic embed (ADR 0024 §3): the load card, and after Load one sandboxed iframe. No player, no sync loop. */
  const showGeneric = (embed: unknown, itemId: string | undefined): void => {
    const gf = genericFrame(embed);
    // Keyed by queue item too: the same page queued twice is a new card, so it waits for its own Load click.
    const nextKey = gf === null ? null : `generic:${itemId ?? ""}:${gf.key}`;
    if (nextKey === tvKey) return;
    tvKey = nextKey;
    tvScreen = null;
    syncNotice.hidden = true;
    tvHint.hidden = true;
    if (tvProvider !== null) {
      tvProvider = null;
      fit();
    }
    showSyncChrome(false);
    if (gf === null) {
      // Our own host or a malformed embed: render nothing from it.
      controls.replaceChildren(fsKey);
      tv.replaceChildren(tvEmpty);
      return;
    }
    const g = createGenericTv(gf);
    tv.replaceChildren(g.screen);
    controls.replaceChildren(g.strip, fsKey);
  };

  const scheduleExpiry = (): void => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    const at = nextExpiry(state);
    if (at === null) return;
    expiryTimer = setTimeout(() => {
      // Never earlier than the expiry it was set for: a timer that fires a hair early would change nothing and not re-arm.
      dispatch({ type: "tick", now: Math.max(Date.now(), at) });
    }, Math.max(0, at - Date.now()));
  };

  const dispatch = (e: ViewEvent): void => {
    const next = reduce(state, e);
    if (next === state) return;
    for (const entry of logEntries(state, next, e)) {
      chatLog.append(entry);
      // Popped out: the window gets the line now, not on the next frame (a hidden tab draws none).
      relay?.append(entry);
      // Collapsed in full screen: count what others said while the lines are out of sight.
      if (stripMode === "band" && fs.mode() !== "off" && entry.kind === "chat" && !entry.self) {
        unread++;
        renderStrip();
      }
    }
    const expiriesChanged = next.bubbles !== state.bubbles || next.syslines !== state.syslines || next.cooldownUntil !== state.cooldownUntil;
    const prevRoom = state.room;
    const prevOwner = state.owner;
    state = next;
    // Straight to the sync loop, not via the next frame: a new playback is a hard seek.
    const room = next.room;
    if (room?.embed !== prevRoom?.embed || room?.playback !== prevRoom?.playback) {
      playback.setRoom(room === null ? { embed: null, playback: null } : { embed: syncedOnly(room.embed), playback: room.playback ?? null, itemId: room.itemId });
      syncTv(next);
    }
    if (next.owner !== prevOwner || next.room?.controlPolicy !== prevRoom?.controlPolicy) playback.setControl({ policy: controlPolicy(next), held: controlHeld(next) });
    if (expiriesChanged) scheduleExpiry();
    // Always, so a window adopted later starts from the room as it is (only posted while popped out, and if changed).
    relay?.update(popState(next));
    relay?.view(next);
    // Removed, closed or full while popped out: the window closes now, not on the next frame (a hidden tab draws none).
    if (popped && !screen(next).chat) relay?.bringBack();
    if (frame === 0) frame = requestAnimationFrame(render);
  };

  const shareToken = trackShareToken(sessionStorage, opts.roomId);
  const emoted = (id: MemberId, kind: EmoteKind): void => {
    relay?.emote(id, kind);
    if (!roomOut()) roomStage.emote(id, kind, state);
  };
  const kickedStore = sessionStorage;
  const sinks: RoomEventSinks = { clock, shareToken, joined: () => { playback.joined(); }, kicked: (wasIn) => (wasIn ? rememberKick : bouncedUntil)(kickedStore, opts.roomId, Date.now()), dispatch, emoted };
  // Kicked from this room in this tab and the cooldown isn't over (ADR 0030 §2): show the notice, don't even try to join.
  const kickedTill = kickedUntil(kickedStore, opts.roomId, Date.now());
  const c: Connection = kickedTill !== null ? stoppedConnection() : createConnection({
    url: opts.socketUrl,
    join: joinMessage(opts.nickname, opts.avatar, opts.secret),
    createSocket: browserSocket,
    onOpen: () => {
      clock.start();
    },
    onEvent: (e) => {
      routeConnectionEvent(e, sinks, Date.now());
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h);
    },
  });

  conn = c;
  // R-M7a Q3 (a): the pop-out talks to this tab over a BroadcastChannel named for the room and this page load (never
  // kept: a duplicated tab must not share it, and a reload leaves the window on the set k plug); this tab keeps the socket.
  const tab = randomId("t");
  relay =
    typeof BroadcastChannel === "function"
      ? createChatRelay({
          channel: browserChannel(channelName(opts.roomId, tab)),
          send: (m) => c.send(m),
          openWindow: (kind) => {
            if (kind === "room") window.open(roomPopoutUrl(opts.roomId, tab), "_blank", "noopener,popup,width=1280,height=668");
            else window.open(popoutUrl(opts.roomId, tab), "_blank", "noopener,popup,width=380,height=640");
          },
          onPopped,
          onSeat: (seat) => {
            const msg = sitIntent(state, seat);
            if (msg !== null) c.send(msg);
          },
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (h) => {
            clearTimeout(h);
          },
        })
      : null;
  popKey.addEventListener("click", () => {
    relay?.popOut();
  });
  bringBack.addEventListener("click", () => {
    relay?.bringBack();
  });
  popRoomKey.addEventListener("click", () => {
    relay?.popOut("room");
  });
  roomBack.addEventListener("click", () => {
    relay?.bringBack();
  });
  showWindow.addEventListener("click", () => {
    relay?.raise();
  });
  playback.start();
  if (kickedTill !== null) dispatch({ type: "kicked", until: kickedTill });

  overlay.addEventListener("click", (ev) => {
    if (!(ev.target instanceof HTMLElement)) return;
    const seat = Number(ev.target.closest<HTMLElement>("[data-seat]")?.dataset["seat"] ?? NaN);
    const msg = sitIntent(state, seat);
    if (msg !== null) c.send(msg);
  });
  chatForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    // Held while the server says rate_limited; the text stays in the box for when it reopens.
    if (chatView(state, Date.now()).cooling) return;
    const msg = chatIntent(chatInput.value);
    if (msg !== null && c.send(msg)) chatInput.value = "";
  });
  // Keys 1–6 emote and Escape closes the picker, anywhere on the page but a text field, while we're in the room.
  window.addEventListener("keydown", (ev) => {
    // The report dialog is modal: the room's keys wait until it closes.
    if (report?.isOpen() === true) return;
    if (moderation?.key(ev) === true) ev.preventDefault();
    else if (state.status === "open" && !chatForm.hidden && picker.key(ev)) ev.preventDefault();
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !wrap.hidden && fs.key(ev.key, typingIn(ev.target), ev.repeat)) ev.preventDefault();
    else if (state.status === "open" && !chatForm.hidden) {
      // Enter with nothing that takes it focused jumps to the message field, here or in full screen; Esc hands back (OME-642).
      const k = chatKey(ev, chatInput);
      if (k === null) return;
      ev.preventDefault();
      if (k === "focus") chatInput.focus();
      else chatInput.blur();
    }
  });
  // Close on unload so the server frees the seat now; a bfcache restore reconnects.
  window.addEventListener("pagehide", () => {
    relay?.close();
    c.close();
    shareToken.clear();
    clock.stop();
  });
  window.addEventListener("pageshow", (ev) => {
    if (!ev.persisted) return;
    c.resume();
    relay?.resume();
  });

  const onMedia = (): void => {
    // Moving a focused node blurs it: whatever you were typing in keeps focus when the chat changes column.
    const focused = document.activeElement;
    const restoreScroll = holdScroll();
    // No pop-out on a phone (set k): a window narrowed that far takes its chat back.
    if (phone.matches) relay?.bringBack();
    renderChatRow(state);
    placeChat();
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    fit();
    restoreScroll();
    render();
    requestRender();
  };
  phone.addEventListener("change", onMedia);
  wide.addEventListener("change", onMedia);
  syncTv(state);
  render();
  pbView = playback.view();
  renderControls();
  return { state: () => state, send: (m) => c.send(m), playback: () => playback.view(), scene: () => view.drawOrder(), layoutBuilds: () => roomStage.layoutBuilds(), avatarFrames: (id) => view.frames(id), queueRenders: () => queuePanel.renders(), roomPaused: () => view.paused() };
}
