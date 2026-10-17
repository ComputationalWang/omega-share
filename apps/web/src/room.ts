// Room screen. Loaded lazily after Enter so PixiJS stays out of the initial bundle.
// The room chrome (OME-1023): Vite loads this stylesheet before the chunk resolves, so the room never paints unstyled.
import "./room.css";
import "pixi.js/unsafe-eval";
import { MAX_ROOM_MEMBERS, type Avatar, type ClientMessage, type EmoteKind, type FloorCell, type MemberId, type Nickname, type ResumeToken, type RoomId } from "@omega/shared";
import { browserNow, createClockSync } from "./clock";
import { createConnection, type Connection } from "./connection";
import { browserSocket, stoppedConnection } from "./room-socket";
import { trackShareToken } from "./share-token";
import { clearResume, saveResume, type ResumeStore } from "./session-record";
import { presenceHint } from "./session-lifecycle";
import { routeConnectionEvent, type RoomEventSinks } from "./room-events";
import { inviteLink, joinMessage, retitleRoom, type RoomSecret, type SecretsStore } from "./room-secrets";
import { createInviteControl } from "./controls/invite";
import { el, sprite } from "./controls/dom";
import { createPlaybackController, type PlaybackView } from "./controls/playback";
import { createRoomTv, syncedOnly } from "./room-tv";
import { qualityMemory } from "./controls/quality";
import { createQueuePanel } from "./controls/queue-panel";
import { ERROR_TEXT, STATUS_TEXT, chatView } from "./controls/feedback";
import { bouncedUntil, kickedUntil, rememberKick } from "./kick-memory";
import { chatIntent, sitIntent, stepAllowed, stepCell, walkIntent } from "./intents";
import { layoutOf } from "./furniture";
import { createPendingApplier } from "./pending-layout";
import { PHONE_QUERY, SHORT_QUERY, STAGE_W, WIDE_QUERY, type Rect } from "./layout";
import { createRoomLayout } from "./room-layout";
import { createStage, type Stage } from "./stage";
import { controlHeld, controlPolicy, initialState, nextExpiry, reduce, screen, type ViewEvent, type ViewState } from "./state";
import type { ExtensionBridge } from "./extension-bridge";
import { createOwnerTools } from "./owner-tools";
import { createEmotePicker } from "./emote/picker";
import { createChatLog } from "./chat/log";
import { logEntries } from "./chat/feed";
import { chatKey } from "./chat/enter";
import { browserChannel, channelName, popoutSupported, popoutUrl, randomId, roomPopoutUrl, type PopState } from "./popout/channel";
import { createChatRelay, type ChatRelay } from "./popout/relay";
import { createRoomCards } from "./room-cards";
import { createHelp } from "./help/dialog";
import { createFirstHint } from "./help/hint";
import { createHiddenMembers } from "./hide/hidden";
import { createPeople } from "./hide/people";
import { NOT_FOUND_TITLE, roomPageTitle } from "./page-title";

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
  /** The page's bridge to the Omega Share extension, for "Unlock with extension" (ADR 0047). */
  readonly extension: ExtensionBridge;
  /** The site origin the invite link starts with. */
  readonly origin: string;
  /** The server's HTTP origin, for the owner's `DELETE /rooms/:id`. */
  readonly serverUrl: string;
  /** From this tab's stored session for the room (ADR 0043): the join resumes that member instead of making a new one. */
  readonly resumeToken?: ResumeToken;
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
  /** How many times the room canvas has drawn (room-view.ts `renders`), for e2e "a bubble costs no render" checks. */
  readonly roomRenders: () => number;
  /** A member's avatar alpha (dimmed when I hid them, OME-769), for e2e checks. */
  readonly avatarAlpha: (id: MemberId) => number | undefined;
  /** The holiday theme drawn now (room-view.ts `theme`), for e2e. */
  readonly theme: () => ReturnType<Stage["view"]["theme"]>;
}

const NOTICE_MS = 3000;
/** Typing somewhere: letters belong to the field, not to the page's keys. */
function typingIn(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);
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
  /** Whether the first answer from the server has been shown (and focus placed for a keyboard joiner, OME-701). */
  let landed = false;
  const cards = createRoomCards({
    roomId: opts.roomId,
    serverUrl: opts.serverUrl,
    secrets: opts.secrets,
    owns: opts.secret?.ownerToken !== undefined,
    fetch: (url, init) => fetch(url, init),
    leave: () => { leaveForGood(); },
    reclaim: () => {
      dispatch({ type: "reclaim" });
      c.reclaim();
    },
  });
  const writeText = (t: string): Promise<void> => ("clipboard" in navigator ? navigator.clipboard.writeText(t) : Promise.reject(new Error("no clipboard")));
  const { root: invite, stop: stopInvite } = createInviteControl(inviteLink(opts.origin, opts.roomId, opts.secret?.inviteKey), opts.secret?.inviteKey !== undefined, writeText);
  invite.hidden = true;

  // The TV and its control bar sit above the scaled stage, unscaled, so the player keeps
  // YouTube's minimum size and no room layer can stack over it (layout.ts `roomLayout`).
  // Under prefers-reduced-motion an emote is a static badge over the avatar instead of an animation (OME-415).
  const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
  /** Set once the emote key exists: my own avatar walking closes the wheel (OME-732). */
  let closeWheel = (): void => undefined;
  const roomStage: Stage = await createStage({
    reducedMotion,
    onMove: (id) => {
      if (id === state.self) closeWheel();
    },
    requestRender: () => {
      requestRender();
    },
    onLayout: (points) => {
      layout.seats(points);
    },
    onFloor: (cell) => walkTo(cell),
    onStep: (key, repeat) => {
      const now = performance.now();
      if (!stepAllowed(repeat, now, lastStep)) return true;
      // From where I'm headed (my cell), else where I'm drawn (a seat, my standing spot).
      const me = state.room?.members.find((m) => m.id === state.self);
      const from = me?.cell ?? (state.self === null ? null : roomStage.cellOf(state.self));
      const to = from === null ? null : stepCell(from, key);
      if (to === null) return from === null;
      lastStep = now;
      return walkTo(to);
    },
  });
  /** Free walking (OME-1350): send `walk` to free floor; false (the floor flashes) when nobody can stand there. */
  function walkTo(cell: FloorCell): boolean {
    const msg = walkIntent(state, cell);
    if (msg === "blocked") return false;
    if (msg !== null) send(msg);
    return true;
  }
  let lastStep = -Infinity;
  const { root: stage, overlay, tags, view } = roomStage;
  const clip = el("div", { className: "stage-clip" }, "room-window");
  clip.append(stage);
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
  // The full-screen element (OME-597): an existing ancestor of the TV, so going full screen moves no node and the
  // provider's iframe never reloads.
  const wrap = el("div", { className: "stage-wrap", hidden: true }, "fs-root");
  const tvBox = createRoomTv({
    playback,
    extension: opts.extension,
    wrap,
    fullscreen: () => layout.fs.mode() !== "off",
    onProvider: () => {
      layout.fit();
    },
  });
  const { tv, controls } = tvBox;
  wrap.append(tv, controls, clip);

  const chatForm = el("form", { className: "chat" });
  const chatInput = el("input", { type: "text", maxLength: 280, placeholder: "Say something…", autocomplete: "off", ariaLabel: "Chat message" }, "chat-input");
  const chatSend = el("button", { type: "submit", textContent: "Say" }, "chat-send");
  // A phone's keyboard shows a Send key; Enter sends either way (it submits the form).
  chatInput.enterKeyHint = "send";
  // A tap or click on the key keeps the field focused, so a phone's keyboard stays up between lines (OME-905).
  chatSend.addEventListener("mousedown", (ev) => {
    if (document.activeElement === chatInput) ev.preventDefault();
  });
  // The emote key and its picker (OME-415) lead the chat row: both are how you speak up.
  const picker = createEmotePicker({
    send: (m) => send(m),
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
    // Over my own head when it's in the room's window; else (watch-only, panned away, room popped out) docked. It may
    // overlap the TV and its shelf (it's brief): a scaled-down stage alone rarely has 196 px above a head.
    locate: () => {
      if (layout.portraitOn() && (layout.dock.sheet.open || opts.root.classList.contains("portrait-typing"))) return null;
      const visible = (r: DOMRect): Rect => {
        const x = Math.max(0, r.left);
        const y = Math.max(0, r.top);
        return { x, y, w: Math.min(innerWidth, r.right) - x, h: Math.min(innerHeight, r.bottom) - y };
      };
      const room = visible(wrap.getBoundingClientRect());
      const p = state.self === null || wrap.hidden || roomOut() ? undefined : roomStage.head(state.self);
      if (p === undefined) return { head: null, room };
      const s = stage.getBoundingClientRect();
      const k = s.width / STAGE_W;
      const head = { x: s.left + p.x * k, y: s.top + p.y * k };
      const seen = visible(clip.getBoundingClientRect());
      const inView = head.x >= seen.x && head.x <= seen.x + seen.w && head.y >= seen.y && head.y <= seen.y + seen.h;
      return { head: inView ? head : null, room };
    },
    // The hint's emote line is done. It leaves the flow, and the stage is refitted now rather than on the next resize
    // callback, before the wheel is placed over my head (`firstHint` and `fit` are made below; a wheel only opens once the room is up).
    onOpen: () => {
      if (layout.portraitOn() && document.activeElement === chatInput) chatInput.blur();
      if (!firstHint.isOpen()) return;
      firstHint.dismiss();
      layout.fit();
    },
  });
  closeWheel = () => {
    picker.close();
  };
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
  // The "?" help (OME-768): the room bar's last key; its dialog is built on the first open and never draws on the canvas.
  const help = createHelp({ owner: () => state.owner && opts.secret?.ownerToken !== undefined });
  help.key.hidden = true;
  // "Hide for me" (OME-769): who I hid in this room, in this tab only. Never sent: it filters at intake (room-events.ts),
  // and the stage, the logs and the pop-out follow each change once.
  const hidden = createHiddenMembers({
    // The `sessionStorage` getter itself throws when storage is blocked.
    getItem: (k) => sessionStorage.getItem(k),
    setItem: (k, v) => {
      sessionStorage.setItem(k, v);
    },
  }, opts.roomId);
  const isHidden = (id: string): boolean => hidden.has(id);
  const people = createPeople({
    hidden,
    onChange: (id, on) => {
      roomStage.hide(id, on);
      chatLog.hideFrom(isHidden);
      relay?.hideFrom(isHidden);
      if (on) dispatch({ type: "hide", memberId: id });
    },
  });
  people.key.hidden = true;
  for (const id of hidden.ids()) roomStage.hide(id, true);
  // A right-click, or a long-press on touch (Chromium fires contextmenu for it), on someone else's name tag opens People
  // on their "Hide for me" button. My own tag keeps the browser's menu.
  tags.addEventListener("contextmenu", (ev) => {
    const tag = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-member]") : null;
    const id = tag?.dataset["member"];
    if (id === undefined || id === state.self || people.key.hidden) return;
    ev.preventDefault();
    people.open(id);
  });
  roomTop.append(title, popRoomKey, people.key, help.key);
  // The first-visit hint (OME-768): in the flow under the room bar, so it never covers the picture or the composer.
  const firstHint = createFirstHint({
    // The `localStorage` getter itself throws when storage is blocked.
    storage: {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => {
        localStorage.setItem(k, v);
      },
    },
    touch: () => globalThis.matchMedia("(hover: none)").matches,
    next: () => (help.key.hidden ? null : help.key),
  });
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

  // "Up next" (ADR 0031): the room's queue under the TV. Its rows are text; it redraws only when the queue changes.
  const queuePanel = createQueuePanel({ send, ownHosts: [location.hostname] });

  // The provider hint sits right above the TV, next to what it's about (OME-251): below the stage it's off-screen.
  // The owner's "Edit room" key (set (h)): made only for the owner, and the editor chunk loads only when it's pressed.
  const editBar = el("div", { className: "edit-bar" });
  const editorPanel = el("div", { className: "editor-panel" });
  // Set (k) phone watch layout (OME-596): TV full width, the room at 1× in a window you drag, chat right under it, no editor.
  const phone = globalThis.matchMedia(PHONE_QUERY);
  const portrait = globalThis.matchMedia(`${PHONE_QUERY} and (orientation: portrait)`);
  // Desktop wide layout (OME-642): the room on the left, the chat and Up next in a full-height column on the right.
  const wide = globalThis.matchMedia(WIDE_QUERY);
  const short = globalThis.matchMedia(SHORT_QUERY);
  const side = el("div", { className: "room-side", hidden: true }, "room-side");
  // Touch (the design system's coarse pointer, or the phone layout): the send key is a 44 px icon named "Send", so the
  // field keeps its room in full screen's narrow strip (OME-905). A mouse and keyboard keep the word "Say".
  const coarse = globalThis.matchMedia("(pointer: coarse)");
  /** A phone, or a touch screen held sideways past the phone layout's width: no pop-out windows there (set k: desktop only). */
  const touchOnly = (): boolean => phone.matches || coarse.matches;
  const renderSend = (): void => {
    const icon = touchOnly();
    if (chatSend.classList.contains("chat-send-icon") === icon) return;
    if (icon) {
      chatSend.className = "ui-button icon chat-send-icon";
      chatSend.ariaLabel = "Send";
      chatSend.title = "Send";
      chatSend.replaceChildren(sprite("ui-icon-send"));
    } else {
      chatSend.className = "";
      chatSend.removeAttribute("aria-label");
      chatSend.removeAttribute("title");
      chatSend.replaceChildren("Say");
    }
  };
  renderSend();
  opts.root.replaceChildren(roomTop, firstHint.root, people.panel, people.status, status, tvBox.hint, wrap, roomAway, editBar, editorPanel, tvBox.personal, queuePanel.root, tvBox.notice, notice, chatLog.root, chatForm, invite, ...cards.cards, side, cards.foot, help.dialog);
  // Declared before the layout: its first fit() reads roomOut.
  /** The room tab's end of the pop-out chat; null where BroadcastChannel is missing. Made once the socket exists. */
  let relay: ChatRelay | null = null;
  let popped = false;
  /** The whole room is in the window (OME-600): the page shows the picture only. */
  const roomOut = (): boolean => popped && relay?.kind() === "room";
  const layout = createRoomLayout({
    root: opts.root,
    wrap,
    clip,
    stage,
    labelScale: (k) => {
      roomStage.labelScale(k);
    },
    tv: tvBox,
    log: chatLog,
    composer: { form: chatForm, away: chatAway, popOut, picker },
    queue: queuePanel,
    notice,
    roomAway,
    invite,
    side,
    ownerBar: editBar,
    editorPanel,
    settings: [editBar, tvBox.personal, invite, cards.foot, firstHint.root],
    phone,
    coarse,
    portrait,
    wide,
    short,
    stageShown: () => screen(state).stage,
    roomOut,
    hint: firstHint,
    placeRoom: () => {
      renderRoomPlace();
    },
  });

  let frame = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let shownError: ViewState["lastError"] = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  function renderControls(): void {
    ctlFrame = 0;
    const v = pbView;
    if (v === null) return;
    tvBox.show(v);
    roomStage.applyCatching(state, v.catching);
  }

  const requestRender = (): void => {
    if (frame === 0) frame = requestAnimationFrame(render);
  };

  const owner = createOwnerTools({
    ownerToken: opts.secret?.ownerToken,
    roomId: opts.roomId,
    serverUrl: opts.serverUrl,
    stage,
    layer: wrap,
    tags,
    view,
    anchor: (id) => roomStage.anchor(id),
    bar: editBar,
    panel: editorPanel,
    state: () => state,
    send,
    requestRender,
    phone: () => phone.matches,
    roomOut,
    log: (e) => { chatLog.append(e); },
  });

  /** The seat the phone's window last centred on, so it follows me when I sit, and only then. */
  let centredSeat = -1;
  /** The stage's place: the room (paused in full screen or while it's in its window) or the placeholder. */
  const renderRoomPlace = (): void => {
    const on = layout.fs.mode() !== "off";
    const out = roomOut();
    clip.hidden = on || out;
    view.setPaused(on || out);
    layout.strip.hidden = !on || out;
    roomAway.hidden = !out;
    popRoomKey.hidden = out || !screen(state).stage || !popoutSupported({ hasChannel: relay !== null, phone: touchOnly() });
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
    popOut.hidden = !popoutSupported({ hasChannel: relay !== null, phone: touchOnly() });
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
    if (out) owner.closeEditor();
    renderChatRow(state);
    owner.render(state);
    layout.fit();
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
    if (!roomOut()) roomStage.render(s, owner.preview() ?? layoutOf(s.room), pbView?.catching === true);
    const mySeat = s.self === null ? -1 : (s.room?.seats.indexOf(s.self) ?? -1);
    if (mySeat !== centredSeat) {
      centredSeat = mySeat;
      // Sat down: the hint's first thing done.
      if (mySeat !== -1) firstHint.dismiss();
      const p = roomStage.seat(mySeat);
      if (p !== undefined) layout.centre(p);
    }
    if (title.textContent !== (s.title ?? "")) title.textContent = s.title ?? "";
    title.hidden = s.title === null;
    owner.render(s);
    status.textContent = STATUS_TEXT[s.status];
    const shown = screen(s);
    wrap.hidden = !shown.stage;
    help.key.hidden = !shown.stage;
    people.key.hidden = !shown.stage;
    if (shown.stage) people.update(s.room?.members ?? [], s.self);
    else people.close();
    if (!shown.stage) {
      firstHint.dismiss();
      if (help.isOpen()) help.close();
    } else if (s.status === "open") firstHint.show();
    // Removed, closed or full: no picture to watch any more.
    if (!shown.stage && layout.fs.mode() !== "off") layout.fs.exit();
    renderChatRow(s);
    invite.hidden = !shown.stage;
    if (layout.syncPortrait()) layout.fit();
    queuePanel.root.hidden = !shown.stage;
    const queueClaimed = queuePanel.update(s);
    cards.render(s);
    const chat = chatView(s, Date.now());
    chatForm.dataset["cooldown"] = String(chat.cooling);
    chatSend.disabled = chat.cooling;
    // Muted by the host (ADR 0030, set j): a read-only well that says why. Emotes still work.
    chatInput.readOnly = chat.muted;
    chatInput.classList.toggle("is-muted", chat.muted);
    chatForm.dataset["muted"] = String(chat.muted);
    // Set k (OME-642): with a keyboard, the open field says how to reach it.
    const hint = chat.cooling || touchOnly() ? chat.placeholder : "Press Enter to chat";
    if (chatInput.placeholder !== hint) chatInput.placeholder = hint;

    if (s.lastError !== shownError) {
      shownError = s.lastError;
      // An add refusal the queue panel already says under its field isn't said twice (QA OME-569 F3).
      if (s.lastError !== null && !queueClaimed) {
        notice.textContent = ERROR_TEXT[s.lastError.code];
        notice.hidden = false;
        if (noticeTimer !== null) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
          notice.hidden = true;
        }, NOTICE_MS);
      }
    }

    owner.moderate(s);
    // The landing form held focus and is gone: once the room (or the card in its place) shows, its first key takes it.
    if (!landed && s.status !== "idle" && s.status !== "connecting" && s.status !== "reconnecting") {
      landed = true;
      const a = document.activeElement;
      if (a === null || a === document.body || (a instanceof HTMLElement && !a.checkVisibility())) firstKey(opts.root)?.focus({ preventScroll: true });
    }
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

  // A saved layout picked at creation (OME-910): sent once, as soon as the owner's first snapshot is in.
  // The `sessionStorage` getter itself throws when storage is blocked; the applier catches it.
  const applyPending = createPendingApplier(
    { getItem: (k) => sessionStorage.getItem(k), removeItem: (k) => { sessionStorage.removeItem(k); } },
    opts.roomId,
    send,
    [location.hostname],
  );
  // The tab's title (OME-1238): others' chat while the tab is hidden counts in front. Written on chat, rename and status
  // changes only, never per frame (a hidden tab draws none anyway).
  let unread = 0;
  const writeTitle = (s: ViewState): void => {
    const t = screen(s).notFound ? NOT_FOUND_TITLE : roomPageTitle(s.title, unread);
    if (document.title !== t) document.title = t;
  };
  const dispatch = (e: ViewEvent): void => {
    const next = reduce(state, e);
    if (next === state) return;
    const unreadBefore = unread;
    // Who said it, so "Hide for me" can take a line down later (OME-769).
    const from = e.type === "server" && e.msg.type === "chat" ? e.msg.memberId : undefined;
    for (const entry of logEntries(state, next, e)) {
      chatLog.append(entry, from);
      // Popped out: the window gets the line now, not on the next frame (a hidden tab draws none).
      relay?.append(entry, from);
      // Collapsed in full screen: count what others said while the lines are out of sight.
      if (entry.kind === "chat" && !entry.self) {
        layout.missed();
        if (document.visibilityState === "hidden") unread++;
      }
    }
    const expiriesChanged = next.bubbles !== state.bubbles || next.syslines !== state.syslines || next.cooldownUntil !== state.cooldownUntil;
    const prevRoom = state.room;
    const prevOwner = state.owner;
    if (unread !== unreadBefore || next.title !== state.title || next.status !== state.status) writeTitle(next);
    // Keeps Your rooms' label current for a room this browser saved (OME-1284).
    if (next.title !== null && next.title !== state.title) retitleRoom(opts.secrets, opts.roomId, next.title);
    state = next;
    applyPending({ owner: next.owner && opts.secret?.ownerToken !== undefined, hasRoom: next.room !== null });
    // Straight to the sync loop, not via the next frame: a new playback is a hard seek.
    const room = next.room;
    if (room?.embed !== prevRoom?.embed || room?.playback !== prevRoom?.playback) {
      playback.setRoom(room === null ? { embed: null, playback: null } : { embed: syncedOnly(room.embed), playback: room.playback ?? null, itemId: room.itemId });
      tvBox.sync(next);
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

  const shareToken = trackShareToken(sessionStorage, opts.roomId, { durable: true });
  // This tab's session for the room (ADR 0043). The `sessionStorage` getter itself throws when storage is blocked;
  // session-record.ts catches it, and the room then just won't survive a reload.
  const resumeStore: ResumeStore = {
    getItem: (k) => sessionStorage.getItem(k),
    setItem: (k, value) => {
      sessionStorage.setItem(k, value);
    },
    removeItem: (k) => {
      sessionStorage.removeItem(k);
    },
  };
  /** The last presence hint sent on this socket; the server clears away on a (re)join. */
  let sentAway = false;
  /** Send the away hint this tab owes, if any (on a visibility change, and after each rejoin). */
  const sendPresence = (open: boolean): void => {
    const away = presenceHint({ hidden: document.visibilityState === "hidden", sent: sentAway, open });
    if (away !== null && conn?.send({ type: "presence", away }) === true) sentAway = away;
  };
  const emoted = (id: MemberId, kind: EmoteKind): void => {
    relay?.emote(id, kind);
    if (!roomOut()) roomStage.emote(id, kind, state);
  };
  const kickedStore = sessionStorage;
  const sinks: RoomEventSinks = { clock, shareToken, joined: () => { playback.joined(); }, kicked: (wasIn) => (wasIn ? rememberKick : bouncedUntil)(kickedStore, opts.roomId, Date.now()), dispatch, emoted, hidden: isHidden, session: (token) => {
    sentAway = false;
    saveResume(resumeStore, { roomId: opts.roomId, token, nickname: opts.nickname, avatar: opts.avatar });
    // The server cleared away on this (re)join; a tab that came back while still hidden says so again.
    sendPresence(true);
  } };
  // Kicked from this room in this tab and the cooldown isn't over (ADR 0030 §2): show the notice, don't even try to join.
  const kickedTill = kickedUntil(kickedStore, opts.roomId, Date.now());
  const c: Connection = kickedTill !== null ? stoppedConnection() : createConnection({
    url: opts.socketUrl,
    join: joinMessage(opts.nickname, opts.avatar, opts.secret),
    durable: true,
    ...(opts.resumeToken === undefined ? {} : { resumeToken: opts.resumeToken }),
    createSocket: browserSocket,
    onOpen: () => {
      clock.start();
    },
    onEvent: (e) => {
      // The session is over for this tab: a reload shows the ordinary Enter (a replaced one keeps its token in memory only).
      if (e.type === "expired" || e.type === "replaced" || e.type === "kicked" || e.type === "room-closed") clearResume(resumeStore, opts.roomId);
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
    if (msg !== null && c.send(msg)) {
      chatInput.value = "";
      firstHint.dismiss();
      // Sent from the key without the field focused: the next line goes straight in.
      if (document.activeElement === chatSend) chatInput.focus({ preventScroll: true });
    }
  });
  // Keys 1–8 emote and Escape closes the picker, anywhere on the page but a text field, while we're in the room.
  window.addEventListener("keydown", (ev) => {
    // The report and help dialogs are modal: the room's keys wait until they close.
    if (cards.reportOpen() || help.isOpen()) return;
    if (layout.dock.sheet.open) {
      if (ev.target instanceof Node && picker.root.contains(ev.target) && picker.key(ev)) ev.preventDefault();
      return;
    }
    // Esc dismisses the first-visit hint and still does whatever else it does here.
    if (ev.key === "Escape") firstHint.dismiss();
    if (owner.key(ev)) ev.preventDefault();
    else if (!help.key.hidden && help.shortcut(ev)) ev.preventDefault();
    else if (state.status === "open" && !chatForm.hidden && picker.key(ev)) ev.preventDefault();
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !wrap.hidden && layout.fs.key(ev.key, typingIn(ev.target), ev.repeat)) ev.preventDefault();
    else if (state.status === "open" && !chatForm.hidden) {
      // Enter with nothing that takes it focused jumps to the message field, here or in full screen; Esc hands back (OME-642).
      const k = chatKey(ev, chatInput);
      if (k === null) return;
      ev.preventDefault();
      if (k === "focus") chatInput.focus();
      else chatInput.blur();
    }
  });
  /** An explicit leave (ADR 0043): tell the server now, best effort, and forget the session; a lost frame ends at the hold's expiry. */
  function leaveForGood(): void {
    c.send({ type: "leave" });
    // Closed now, so a stalled navigation can't time out into a reconnect that re-saves the records (QA OME-1001).
    c.close();
    clearResume(resumeStore, opts.roomId);
    shareToken.clear();
    location.assign("/");
  }
  // Leaving the page is not leaving the room (ADR 0043): close the socket, keep the session and share records. The
  // server holds the seat for the grace window; a reload, a bfcache restore or coming back resumes it.
  window.addEventListener("pagehide", () => {
    relay?.close();
    c.close();
    clock.stop();
    stopInvite();
  });
  window.addEventListener("pageshow", (ev) => {
    if (!ev.persisted) return;
    c.ensureConnected();
    relay?.resume();
  });
  // Hidden: a best-effort away hint on the open socket. Visible again (or resumed from a freeze): make sure the socket
  // is live, probing one that may have died while suspended. One path, so these events never race two connections.
  const onVisibility = (): void => {
    if (document.visibilityState !== "hidden") {
      c.ensureConnected({ probe: true });
      if (unread !== 0) {
        unread = 0;
        writeTitle(state);
      }
    }
    sendPresence(state.status === "open");
  };
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("resume", () => {
    c.ensureConnected({ probe: true });
  });
  // The network is back: reconnect now rather than at the end of the backoff (OME-1248).
  window.addEventListener("online", () => {
    c.ensureConnected({ probe: true });
  });

  const onMedia = (): void => {
    // Moving a focused node blurs it: whatever you were typing in keeps focus when the chat changes column.
    const focused = document.activeElement;
    const restoreScroll = layout.holdScroll();
    // No pop-out on a phone or touch screen (set k): a window narrowed that far takes its chat back.
    if (touchOnly()) relay?.bringBack();
    renderChatRow(state);
    renderSend();
    layout.placeChat();
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    layout.fit();
    restoreScroll();
    render();
    requestRender();
  };
  phone.addEventListener("change", onMedia);
  wide.addEventListener("change", onMedia);
  portrait.addEventListener("change", onMedia);
  coarse.addEventListener("change", onMedia);
  short.addEventListener("change", onMedia);
  tvBox.sync(state);
  writeTitle(state);
  render();
  pbView = playback.view();
  renderControls();
  return { state: () => state, send: (m) => c.send(m), playback: () => playback.view(), scene: () => view.drawOrder(), layoutBuilds: () => roomStage.layoutBuilds(), avatarFrames: (id) => view.frames(id), queueRenders: () => queuePanel.renders(), roomPaused: () => view.paused(), roomRenders: () => view.renders(), avatarAlpha: (id) => view.alpha(id), theme: () => view.theme() };
}
