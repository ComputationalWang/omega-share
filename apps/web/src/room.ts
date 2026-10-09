// Room screen. Loaded lazily after Enter so PixiJS stays out of the initial bundle.
import "pixi.js/unsafe-eval";
import { SEAT_COUNT, isSyncedEmbed, layoutSeats, type AnyEmbed, type Avatar, type ClientMessage, type EmoteKind, type Embed, type ErrorCode, type MemberId, type Nickname, type RoomId, type RoomLayout } from "@omega/shared";
import { browserNow, createClockSync } from "./clock";
import { createConnection, type Connection, type SocketLike } from "./connection";
import { trackShareToken } from "./share-token";
import { routeConnectionEvent, type RoomEventSinks } from "./room-events";
import { forgetRoom, inviteLink, joinMessage, type RoomSecret, type SecretsStore } from "./room-secrets";
import { createInviteControl } from "./controls/invite";
import { createPersonal, createTransport, el, renderSyslines, sprite } from "./controls/dom";
import { createPlaybackController, type PlaybackView } from "./controls/playback";
import { createQueuePanel } from "./controls/queue-panel";
import { chatView, kickedCard, refusalCard } from "./controls/feedback";
import { bouncedUntil, kickedUntil, rememberKick } from "./kick-memory";
import { mountErrorText, playerErrorText, providerHint } from "./controls/player-error";
import { chatIntent, seatViews, sitIntent } from "./intents";
import { layoutKey as keyOfLayout, layoutOf, sceneOf, seatPoints, standDepth, standingPoints, usesSetG } from "./furniture";
import { BUBBLE_OFFSET_Y, PHONE_QUERY, STAGE_H, STAGE_W, SYSLINE_RAIL, TAG_OFFSET_Y, fullscreenLayout, roomLayout, type Point, type Rect, type StripMode } from "./layout";
import { createFullscreen, type FullscreenMode } from "./fullscreen";
import { createRoomWindow } from "./room-window";
import type { PlayerError } from "./player/adapter";
import { PLAYERS, createPlayerMounter } from "./player/registry";
import type { FurnitureAtlas } from "./furniture-atlas";
import { createRoomView, type AvatarPlacement, type RoomView } from "./room-view";
import { catchingUp, controlHeld, controlPolicy, initialState, nextExpiry, reduce, screen, type Refusal, type ViewEvent, type ViewState } from "./state";
import { genericFrame, tvFrame, type TvFrame } from "./tv";
import { createGenericTv } from "./controls/generic-tv";
import { walkGrid } from "./walk/path";
import { standingSpots } from "./walk/standing";
import type { Dir } from "./walk/walks";
import type { Editor } from "./editor/editor";
import type { Moderation } from "./owner/moderation";
import { createEmotePicker } from "./emote/picker";
import { createEmoteBadges } from "./emote/badges";
import { EMOTE_LIFT } from "./walk/animator";
import { createChatLog } from "./chat/log";
import { logEntries } from "./chat/feed";

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

function place(e: HTMLElement, p: Point): void {
  e.style.transform = `translate(${String(p.x)}px, ${String(p.y)}px)`;
}

function box(e: HTMLElement, r: Rect): void {
  Object.assign(e.style, { left: `${String(r.x)}px`, top: `${String(r.y)}px`, width: `${String(r.w)}px`, height: `${String(r.h)}px` });
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
  // 4004: the room was deleted or collected. The connection has stopped; nothing here can bring it back.
  const closed = el("div", { className: "room-full", hidden: true }, "room-closed");
  closed.append(
    el("h2", { textContent: "This room was closed" }),
    el("p", { textContent: "Its owner deleted it, or nobody used it for a long time." }),
    el("a", { className: "enter", href: "/", textContent: "Go to the home page" }),
  );
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
  // .ui-room: set (e)/(c) chrome inside the stage is at the room's 1× art scale.
  const stage = el("div", { className: "stage ui-room" }, "room");
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
  const overlay = el("div", { className: "overlay" });
  // Placed from the room's layout on each render that changes it (applyLayout).
  const seatButtons = Array.from({ length: SEAT_COUNT }, (_, i) => {
    const b = el("button", { type: "button", className: "seat" }, "seat");
    b.dataset["seat"] = String(i);
    return b;
  });
  overlay.append(...seatButtons);
  const tags = el("div", { className: "tags" });
  const bubbles = el("div", { className: "bubbles", ariaLive: "polite" });
  // Chat system lines ("Ana paused"): caption rail in the stage's bottom-left, text only.
  const rail = el("div", { className: "syslines", ariaLive: "polite" });
  box(rail, SYSLINE_RAIL);
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
  chatForm.append(picker.root, chatInput, chatSend);
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
      if (ctlFrame === 0) ctlFrame = requestAnimationFrame(renderControls);
    },
  });
  const transport = createTransport(playback);
  controls.append(transport.root, fsKey);
  const personal = createPersonal(playback);
  // "Up next" (ADR 0031): the room's queue under the TV. Its rows are text; it redraws only when the queue changes.
  const queuePanel = createQueuePanel({ send, ownHosts: [location.hostname] });

  const tagEls = new Map<MemberId, HTMLElement>();
  const bubbleEls = new Map<MemberId, HTMLElement>();
  // Under prefers-reduced-motion an emote is a static badge over the avatar instead of an animation (OME-415).
  const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
  const badges = createEmoteBadges(bubbles, {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  });
  const liftOf = (id: MemberId): number => (state.room?.seats.includes(id) === true ? EMOTE_LIFT.sit : EMOTE_LIFT.idle);
  // Tags, bubbles and emote badges ride along with a walking avatar.
  const view: RoomView = await createRoomView({
    onMove: (id, x, y) => {
      badges.move(id, x, y - liftOf(id));
      const tag = tagEls.get(id);
      if (tag !== undefined) place(tag, { x, y: y + TAG_OFFSET_Y });
      const bubble = bubbleEls.get(id);
      if (bubble !== undefined) place(bubble, { x, y: y + BUBBLE_OFFSET_Y });
    },
  });
  view.canvas.className = "scene";
  stage.append(view.canvas, overlay, tags, bubbles, rail);
  // The provider hint sits right above the TV, next to what it's about (OME-251): below the stage it's off-screen.
  // The owner's "Edit room" key (set (h)): made only for the owner, and the editor chunk loads only when it's pressed.
  const editBar = el("div", { className: "edit-bar" });
  const editorPanel = el("div", { className: "editor-panel" });
  // Set (k) phone watch layout (OME-596): TV full width, the room at 1× in a window you drag, chat right under it, no editor.
  const phone = globalThis.matchMedia(PHONE_QUERY);
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
    wrap.classList.toggle("is-fs", on);
    wrap.classList.toggle("is-pseudo-fs", mode === "pseudo");
    clip.hidden = on;
    view.setPaused(on);
    strip.hidden = !on;
    fsKey.ariaLabel = on ? "Exit full screen" : "Full screen";
    fsIcon.className = `ui-sprite ${on ? "ui-icon-fullscreen-exit" : "ui-icon-fullscreen"}`;
    unread = 0;
    chatLog.setAgeing(on ? "fade" : "settle");
    placeChat();
    setBehindInert(mode === "pseudo");
    renderStrip();
    fit();
    if (wasInRoom) {
      // The room is hidden now: the key you pressed to enter (or the exit key, for F) holds focus meanwhile.
      focusBefore = focused;
      fsKey.focus({ preventScroll: true });
    } else if (!on && focusBefore !== null && (document.activeElement === fsKey || document.activeElement === document.body)) {
      const back = focusBefore;
      focusBefore = null;
      if (back.isConnected) back.focus({ preventScroll: true });
    } else if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    if (!on) focusBefore = null;
  };
  opts.root.replaceChildren(title, status, tvHint, wrap, editBar, editorPanel, personal.root, queuePanel.root, syncNotice, notice, chatLog.root, chatForm, invite, full, refused, closed, kicked);
  /** On a phone the chat follows the room straight away, on screen and in focus order; elsewhere it's under the notices. */
  const placeChat = (): void => {
    if (fs.mode() !== "off") stripHead.after(chatLog.root, chatForm);
    else if (phone.matches) wrap.after(chatLog.root, chatForm);
    else notice.after(chatLog.root, chatForm);
    // Set (k): every key and field is at least 44×44 CSS px to the finger (reference.css .ui-touch).
    opts.root.classList.toggle("ui-touch", phone.matches);
  };
  placeChat();

  /** The shown embed's provider: Twitch needs a larger TV (layout.ts). */
  let tvProvider: Embed["provider"] | null = null;
  /** The phone's window looks at the middle of the seats until you drag it, sit, or focus something off-screen. */
  const roomWindow = createRoomWindow(clip, stage, () => seatsMiddle);
  let seatsMiddle: Point = { x: STAGE_W / 2, y: STAGE_H / 2 };
  const fit = (): void => {
    if (fs.mode() !== "off") {
      const l = fullscreenLayout(wrap.clientWidth, wrap.clientHeight, tvProvider, stripMode);
      box(tv, l.tv);
      box(controls, l.controls);
      box(strip, l.strip);
      strip.dataset["at"] = l.at;
      tv.classList.toggle("compact", l.compact.tv);
      controls.classList.toggle("compact", l.compact.controls);
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
    wrap.style.height = `${String(l.height)}px`;
  };
  new ResizeObserver(fit).observe(wrap);
  fit();

  let frame = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let tvKey: string | null = null;
  let drawnSeats: readonly unknown[] | undefined;
  let drawnMembers: readonly unknown[] | undefined;
  const syslineEls = new Map<number, HTMLElement>();
  /** The drawn layout (furniture.ts): seats, standing spots and the scene follow it; null until the first render. */
  let layout: RoomLayout | null = null;
  let seats: Point[] = [];
  let seatFacings: Dir[] = [];
  /** Who stands on which standing spot; kept across renders so a departure doesn't move the others. */
  let standSpots = new Map<MemberId, number>();
  let grid: Uint8Array = new Uint8Array(0);
  let standing: Point[] = [];
  let scene = sceneOf(layoutOf(null), null);
  /** The set (g) atlas once loaded: later layouts build their scene with it straight away. */
  let atlas: FurnitureAtlas | null = null;
  /** The drawn layout's content; a re-join snapshot parses a new but equal layout, which keeps the scene. */
  let layoutKey = "";
  let layoutBuilds = 0;
  /** The owner's unsaved draft, shown to them instead of the room's layout while they edit. */
  let preview: RoomLayout | null = null;
  let editToggle: HTMLButtonElement | null = null;
  let editor: Editor | null = null;
  /** Bumped on each open/close, so a slow chunk load for an editor that was closed meanwhile is dropped. */
  let editorGen = 0;
  let shownError: ViewState["lastError"] = null;
  /** Where the last render put each member (seat or standing spot), for UI anchored to someone not on screen yet. */
  let placedAt = new Map<MemberId, Point>();
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The hourglass on each catching tag; a tag removed with its member takes its hourglass along. */
  const hourglasses = new Map<HTMLElement, HTMLElement>();

  /** A tag carries the hourglass while that member catches up: mine from my player, others' from the server (ADR 0019). */
  const applyCatching = (): void => {
    for (const [id, tag] of tagEls) {
      const want = id === state.self ? pbView?.catching === true : catchingUp(state, id);
      const glass = hourglasses.get(tag);
      if (want === (glass !== undefined)) continue;
      tag.classList.toggle("catching", want);
      if (glass !== undefined) {
        glass.remove();
        hourglasses.delete(tag);
      } else {
        const g = el("span", { className: "ui-sprite ui-catchup", ariaHidden: "true" });
        tag.prepend(g);
        hourglasses.set(tag, g);
      }
    }
  };

  function renderControls(): void {
    ctlFrame = 0;
    const v = pbView;
    if (v === null) return;
    transport.update(v);
    personal.update(v);
    applyCatching();
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

  /** Rebuild furniture, seats and standing spots for a new layout; the set (g) atlas loads only if the layout needs it. */
  const applyLayout = (next: RoomLayout): void => {
    layout = next;
    const key = keyOfLayout(next);
    if (key === layoutKey) return;
    layoutKey = key;
    layoutBuilds++;
    seats = seatPoints(next);
    seatsMiddle = middleOf(seats);
    if (phone.matches) fit();
    seatFacings = layoutSeats(next).map((s) => s.facing);
    grid = walkGrid(next);
    standing = standingPoints(next);
    const needsAtlas = usesSetG(next);
    const ready = needsAtlas ? atlas : null;
    scene = sceneOf(next, ready?.manifest ?? null);
    view.setScene(scene, ready, grid);
    seatButtons.forEach((b, i) => {
      const p = seats[i];
      if (p !== undefined) place(b, p);
    });
    drawnSeats = undefined;
    if (!needsAtlas || ready !== null) return;
    void import("./furniture-atlas")
      .then((m) => m.loadFurnitureAtlas())
      .then((loaded) => {
        atlas = loaded;
        if (layout !== next) return;
        scene = sceneOf(next, loaded.manifest);
        view.setScene(scene, loaded, grid);
        drawnSeats = undefined;
        if (frame === 0) frame = requestAnimationFrame(render);
      })
      // Without the sheet the room still works: placeholder floor, seats and avatars. The next snapshot retries.
      .catch((e: unknown) => {
        if (layout === next) layoutKey = "";
        console.warn("furniture atlas failed to load", e);
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
          const p = view.position(id) ?? placedAt.get(id);
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
    const want = owns && !phone.matches;
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
  const render = (): void => {
    frame = 0;
    const s = state;
    const nextLayout = preview ?? layoutOf(s.room);
    if (nextLayout !== layout) applyLayout(nextLayout);
    const mySeat = s.self === null ? -1 : (s.room?.seats.indexOf(s.self) ?? -1);
    if (mySeat !== centredSeat) {
      centredSeat = mySeat;
      const p = seats[mySeat];
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
    chatForm.hidden = !shown.chat;
    // Removed (ADR 0030): the log stays up above the card, ending with the only-you line.
    chatLog.root.hidden = !shown.chat && !shown.kicked;
    full.hidden = !shown.full;
    refused.hidden = shown.refused === null;
    invite.hidden = !shown.stage;
    queuePanel.root.hidden = !shown.stage;
    queuePanel.update(s);
    if (kicked.hidden === shown.kicked) {
      kicked.hidden = !shown.kicked;
      if (shown.kicked) renderKicked(s.kickedUntil);
    }
    if (closed.hidden === shown.closed) {
      closed.hidden = !shown.closed;
      if (shown.closed) forgetRoom(opts.secrets, opts.roomId);
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
    if (chatInput.placeholder !== chat.placeholder) chatInput.placeholder = chat.placeholder;

    const placements: AvatarPlacement[] = [];
    const at = new Map<MemberId, Point>();
    placedAt = at;
    const views = seatViews(s);
    for (const v of views) {
      const p = seats[v.index];
      if (v.member !== null && p !== undefined) {
        placements.push({ id: v.member.id, avatar: v.member.avatar, at: p, z: scene.seats[v.index]?.z ?? standDepth(p), seatFacing: seatFacings[v.index] ?? null });
        at.set(v.member.id, p);
      }
    }
    const standers = (s.room?.members ?? []).filter((m) => !at.has(m.id));
    standSpots = standingSpots(standers.map((m) => m.id), standing.length, standSpots);
    for (const m of standers) {
      const i = standSpots.get(m.id);
      const p = i === undefined ? undefined : standing[i];
      if (p === undefined) continue;
      placements.push({ id: m.id, avatar: m.avatar, at: p, z: standDepth(p), seatFacing: null });
      at.set(m.id, p);
    }
    // Chat, bubbles and playback leave seats/members untouched, so the scene is only redrawn when they change.
    const seatsNow = s.room?.seats;
    const membersNow = s.room?.members;
    if (seatsNow !== drawnSeats || membersNow !== drawnMembers) {
      drawnSeats = seatsNow;
      drawnMembers = membersNow;
      view.update(views.map((v) => v.member !== null), placements);
    }
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

    for (const v of views) {
      const b = seatButtons[v.index];
      if (b === undefined) continue;
      b.dataset["occupied"] = String(v.member !== null);
      b.disabled = s.status !== "open";
      b.classList.toggle("mine", v.isSelf);
      b.ariaLabel = v.member === null ? `Seat ${String(v.index + 1)}, free` : v.isSelf ? `Seat ${String(v.index + 1)}, yours: stand up` : `Seat ${String(v.index + 1)}, taken by ${v.member.nickname}`;
    }

    // Nickname tags: exactly one per member, text only.
    const members = new Map((s.room?.members ?? []).map((m) => [m.id, m]));
    for (const [id, e] of tagEls) {
      if (members.has(id)) continue;
      e.remove();
      tagEls.delete(id);
      hourglasses.delete(e);
    }
    badges.keep(members);
    for (const m of members.values()) {
      let e = tagEls.get(m.id);
      if (e === undefined) {
        e = el("span", { className: "tag ui-tag" }, "nickname-tag");
        e.dataset["member"] = m.id;
        e.append(el("span", { className: "tag-name", textContent: m.nickname }));
        tagEls.set(m.id, e);
        tags.append(e);
      }
      e.classList.toggle("self", m.id === s.self);
      const p = view.position(m.id) ?? at.get(m.id);
      if (p !== undefined) place(e, { x: p.x, y: p.y + TAG_OFFSET_Y });
    }

    const live = new Set(s.bubbles.map((b) => b.memberId));
    for (const [id, e] of bubbleEls) {
      if (live.has(id)) continue;
      e.remove();
      bubbleEls.delete(id);
    }
    for (const b of s.bubbles) {
      const p = view.position(b.memberId) ?? at.get(b.memberId);
      let e = bubbleEls.get(b.memberId);
      if (e === undefined) {
        e = el("p", { className: "bubble" }, "chat-message");
        bubbleEls.set(b.memberId, e);
        bubbles.append(e);
      }
      if (e.textContent !== b.text) e.textContent = b.text;
      if (p !== undefined) place(e, { x: p.x, y: p.y + BUBBLE_OFFSET_Y });
    }

    renderSyslines(rail, s.syslines, syslineEls);
    applyCatching();
    renderModeration(s);
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
    if (synced && controls.firstChild !== transport.root) controls.replaceChildren(transport.root, fsKey);
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
    if (frame === 0) frame = requestAnimationFrame(render);
  };

  const shareToken = trackShareToken(sessionStorage, opts.roomId);
  const emoted = (id: MemberId, kind: EmoteKind): void => {
    if (!reducedMotion.matches) {
      view.emote(id, kind);
      return;
    }
    const p = view.position(id);
    if (p !== undefined) badges.show(id, kind, { x: p.x, y: p.y - liftOf(id) });
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
    if (moderation?.key(ev) === true) ev.preventDefault();
    else if (state.status === "open" && !chatForm.hidden && picker.key(ev)) ev.preventDefault();
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !wrap.hidden && fs.key(ev.key, typingIn(ev.target), ev.repeat)) ev.preventDefault();
    else if (ev.key === "Enter" && fs.mode() !== "off" && !chatForm.hidden && (ev.target === document.body || ev.target === wrap || ev.target === chatLog.root)) {
      // Set k: Enter anywhere in full screen jumps to the message field.
      ev.preventDefault();
      chatInput.focus();
    }
  });
  // Close on unload so the server frees the seat now; a bfcache restore reconnects.
  window.addEventListener("pagehide", () => {
    c.close();
    shareToken.clear();
    clock.stop();
  });
  window.addEventListener("pageshow", (ev) => {
    if (ev.persisted) c.resume();
  });

  phone.addEventListener("change", () => {
    fit();
    placeChat();
    requestRender();
  });
  syncTv(state);
  render();
  pbView = playback.view();
  renderControls();
  return { state: () => state, send: (m) => c.send(m), playback: () => playback.view(), scene: () => view.drawOrder(), layoutBuilds: () => layoutBuilds, avatarFrames: (id) => view.frames(id), queueRenders: () => queuePanel.renders(), roomPaused: () => view.paused() };
}
