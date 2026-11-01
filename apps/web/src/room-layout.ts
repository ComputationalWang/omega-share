// Where the room page's pieces sit (split out of room.ts, OME-1100): the page, the wide column (OME-642), the phone
// (OME-596) and its portrait dock (OME-905), and full screen with its chat strip (OME-597). It moves nodes and sizes
// boxes; it never builds what it places.
import type { Embed } from "@omega/shared";
import type { ChatLog } from "./chat/log";
import { el, sprite } from "./controls/dom";
import type { QueuePanel } from "./controls/queue-panel";
import { createFsChat, type FsChat } from "./fs-chat";
import { createFullscreen, type Fullscreen, type FullscreenMode } from "./fullscreen";
import { FS_STRIP_W, PHONE_ROOM_H, ROOM_VIEW, STAGE_W, bandFit, bandHome, chromeZoom, fullscreenLayout, momentsBox, portraitLayout, roomLayout, roomScale, touchHome, wideLayout, type FullscreenLayout, type Point, type Rect, type StripMode } from "./layout";
import { createPortraitDock } from "./portrait-dock";
import { createRoomWindow, windowH, windowMinH } from "./room-window";

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

function box(e: HTMLElement, r: Rect): void {
  Object.assign(e.style, { left: `${String(r.x)}px`, top: `${String(r.y)}px`, width: `${String(r.w)}px`, height: `${String(r.h)}px` });
}

export interface RoomLayoutOptions {
  /** The room page (opts.root), with every piece below already in it. */
  readonly root: HTMLElement;
  /** The full-screen element: the TV, its shelf and the stage's window. */
  readonly wrap: HTMLElement;
  readonly clip: HTMLElement;
  readonly stage: HTMLElement;
  /** The phone window's label scale changed (OME-1184): the bubbles are shown that much bigger (Stage.labelScale). */
  readonly labelScale?: (k: number) => void;
  /** The phone window settled on stage x `x0`–`x1` and bottom `y1` (OME-1945, OME-2118): bubbles and tags keep inside it (Stage.bubbleSides). */
  readonly bubbleSides?: (x0: number, x1: number, y1: number, y0: number) => void;
  /** The TV and its shelf (room-tv.ts). */
  readonly tv: {
    readonly tv: HTMLElement;
    readonly controls: HTMLElement;
    readonly fsKey: HTMLElement;
    readonly personal: HTMLElement;
    provider(): Embed["provider"] | null;
    setFullscreen(on: boolean): void;
    place(): void;
  };
  /** The moments strip (OME-1628): boxed under the shelf, or set aside where it has no room. */
  readonly moments?: HTMLElement;
  readonly log: ChatLog;
  /** The poll card (OME-1454): always right above the log. */
  readonly poll: HTMLElement;
  /** The chat row, its pop-out placeholder, and the keys that lead and end the row. */
  readonly composer: {
    readonly form: HTMLFormElement;
    readonly away: HTMLElement;
    readonly popOut: HTMLElement;
    readonly picker: { readonly root: HTMLElement; close(): void };
  };
  readonly queue: QueuePanel;
  readonly notice: HTMLElement;
  /** The room's live regions outside the wrapper (connection status, notices): full screen says them from inside it. */
  readonly live: readonly HTMLElement[];
  /** The room's pop-out placeholder. */
  readonly roomAway: HTMLElement;
  /** The room's head row (title, Photo, People, Help): the root's first child, or the chat column's on a short screen. */
  readonly roomTop: HTMLElement;
  /** The People panel (outfits and the people list): under the head row, or a tab of the chat column on a wide screen. */
  readonly people: HTMLElement;
  readonly invite: HTMLElement;
  /** The guest's "Report this room" foot: under the room, or under People in the chat column on a short screen (OME-1841). */
  readonly foot: HTMLElement;
  /** The wide layout's right-hand column. */
  readonly side: HTMLElement;
  /** The owner's bar (Edit room, Who controls playback) and the editor's panel under it. */
  readonly ownerBar: HTMLElement;
  readonly editorPanel: HTMLElement;
  /** What the portrait dock's settings sheet holds. */
  readonly settings: readonly HTMLElement[];
  readonly phone: { readonly matches: boolean };
  /** A coarse pointer: touch hit areas (.ui-touch) even past the phone layout's width (QA OME-1324 G1). */
  readonly coarse: { readonly matches: boolean };
  readonly portrait: { readonly matches: boolean };
  readonly wide: { readonly matches: boolean };
  readonly short: { readonly matches: boolean };
  /** The room is up (state.ts `screen().stage`). */
  readonly stageShown: () => boolean;
  /** The whole room is in its own window (OME-600): the page shows the picture only. */
  readonly roomOut: () => boolean;
  readonly hint: { dismiss(): void };
  /** Full screen began or ended: the room's place (paused, or its placeholder) follows. */
  readonly placeRoom: () => void;
}

export interface RoomLayout {
  readonly fs: Fullscreen;
  /** Full screen's "hide chat" (OME-1491): its toggle and the bubbles beside the picture. */
  readonly fsChat: FsChat;
  /** Full screen's chat strip: shown only in full screen, while the room is here. */
  readonly strip: HTMLElement;
  /** Size the TV, its shelf, the strip and the stage for the screen as it is now. */
  readonly fit: () => void;
  /** Move the chat, Up next and the invite to where this screen keeps them. */
  readonly placeChat: () => void;
  /** Call before moving scrolled boxes; call what it returns once the layout settles (QA OME-658). */
  readonly holdScroll: () => () => void;
  /** Portrait follows the state: true if it changed (then refit). */
  readonly syncPortrait: () => boolean;
  readonly portraitOn: () => boolean;
  readonly dock: ReturnType<typeof createPortraitDock>;
  /** A new layout's seats and standing spots: the phone's window looks at the seats, the band at both (OME-1843). */
  readonly seats: (points: readonly Point[], standing: readonly Point[]) => void;
  /** I sat down: the phone's window centres on my seat. */
  readonly centre: (p: Point) => void;
  /** Where I stand (null: seated, or not in the room): the touch window keeps me in view (OME-1930). */
  readonly me: (p: Point | null) => void;
  /** A line from someone else came in: counted while the strip is collapsed in full screen. */
  readonly missed: () => void;
}

const HANDLE_ARROWS = { left: "◀", right: "▶", up: "▲", down: "▼" } as const;
/** How near the screen's bottom edge the pointer peeks the hidden chat (OME-1668). */
const FS_PEEK_ZONE = 80;

export function createRoomLayout(o: RoomLayoutOptions): RoomLayout {
  const { root, wrap, clip, stage, tv: tvBox, log: chatLog, queue: queuePanel, notice, roomAway, invite, side, phone, wide } = o;
  const { tv, controls, fsKey } = tvBox;
  const { form: chatForm, away: chatAway, popOut, picker } = o.composer;

  // Full screen (OME-597, set k `ui-m7-desktop` / `ui-m7-band`). The strip is the TV cabinet's side panel: while full
  // screen lasts the chat log (fading) and the field move into it, beside the picture or under it, or it collapses to the
  // field on one band under the picture.
  const strip = el("aside", { className: "fs-strip ui-fs-strip", ariaLabel: "Chat", hidden: true }, "fs-strip");
  const stripHead = el("div", { className: "fs-strip-head" });
  const stripToggle = el("button", { type: "button", className: "ui-button self icon" }, "fs-strip-toggle");
  const stripIcon = sprite("ui-icon-strip-hide");
  stripToggle.append(stripIcon);
  // Mustard: only your own count of what you missed while collapsed; the key's label says it too.
  const unreadChip = el("span", { className: "ui-chip self fs-unread", ariaHidden: "true", hidden: true });
  stripToggle.append(unreadChip);
  const stripTitle = el("span", { className: "fs-strip-title", textContent: "Chat" });
  stripHead.append(sprite("ui-icon-chat"), stripTitle);
  strip.append(stripHead);
  wrap.append(strip);
  const fsChat = createFsChat({
    store: (() => {
      try {
        return localStorage;
      } catch {
        return null;
      }
    })(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => { clearTimeout(h); },
    onChange: (hidden, peek) => {
      // Hiding takes the strip and the shelf away: focus in them goes to the toggle, now in the pill.
      const focused = document.activeElement;
      wrap.classList.toggle("fs-chat-hidden", hidden);
      wrap.classList.toggle("fs-peek", peek);
      if (hidden && focused instanceof HTMLElement && (strip.contains(focused) || controls.contains(focused))) fsChat.toggle.focus({ preventScroll: true });
      renderStrip();
      fit();
    },
  });
  wrap.append(fsChat.bubbles, fsChat.pill);
  // Chromium leaves everything outside the full-screen element out of the accessibility tree, whatever its CSS
  // (OME-2136): while full screen is on, each live region speaks through an sr-only twin inside the wrapper.
  const live = o.live.map((src) => ({ src, twin: el("p", { className: "sr-only", role: src.getAttribute("role") ?? "status" }) }));
  wrap.append(...live.map((l) => l.twin));
  const mirror = (): void => {
    for (const { src, twin } of live) {
      const text = src.hidden ? "" : src.textContent;
      // The room re-sets the same status on every render: only a real change may be said again.
      if (twin.textContent !== text) twin.textContent = text;
    }
  };
  const mirrorer = new MutationObserver(mirror);
  const setMirror = (on: boolean): void => {
    mirrorer.disconnect();
    if (!on) for (const { twin } of live) twin.textContent = "";
    else {
      for (const { src } of live) mirrorer.observe(src, { childList: true, characterData: true, subtree: true, attributeFilter: ["hidden"] });
      mirror();
    }
  };
  // The pill dims after a while; a pointer over our wrapper (not the provider's iframe, which keeps its events) wakes it.
  const wakePill = (): void => {
    if (fsChat.hidden()) fsChat.wake();
  };
  wrap.addEventListener("pointermove", wakePill, { passive: true });
  wrap.addEventListener("pointerdown", wakePill, { passive: true });
  // OME-1668: a pointer (or a tap) near the screen's bottom edge or over the chat peeks the hidden chat, which goes
  // FS_PEEK_MS after the last such event. No leave event is needed: a real provider's iframe swallows those (QA OME-1754).
  const peekAt = (ev: PointerEvent): void => {
    if (fs.mode() === "off") return;
    const t = ev.target;
    if (ev.clientY >= wrap.getBoundingClientRect().bottom - FS_PEEK_ZONE || (t instanceof Node && (strip.contains(t) || controls.contains(t)))) fsChat.peek(true);
    fsChat.peek(false);
  };
  wrap.addEventListener("pointermove", peekAt, { passive: true });
  wrap.addEventListener("pointerdown", peekAt, { passive: true });
  // Focus in the chat or the shelf, or a draft in the field, holds the peek: never hidden under the caret.
  const holdAt = (to: EventTarget | null): void => {
    fsChat.hold((to instanceof Node && (strip.contains(to) || controls.contains(to))) || (chatForm.querySelector("input")?.value ?? "") !== "");
  };
  wrap.addEventListener("focusin", (ev) => { holdAt(ev.target); });
  wrap.addEventListener("focusout", (ev) => { holdAt(ev.relatedTarget); });
  let stripMode: StripMode = storedStrip();
  let unread = 0;
  let displayedStripMode = stripMode;
  const renderStrip = (mode: StripMode = displayedStripMode): void => {
    displayedStripMode = mode;
    const open = mode === "open";
    strip.dataset["strip"] = mode;
    stripToggle.ariaExpanded = String(open);
    const constrained = mode === "band" && stripMode === "open";
    stripToggle.disabled = constrained;
    stripToggle.title = constrained ? "Rotate your phone or exit full screen to show chat" : "";
    const unreadLabel = unread > 0 ? `, ${String(unread)} new message${unread === 1 ? "" : "s"}` : "";
    stripToggle.ariaLabel = constrained ? `Chat needs more space; rotate your phone or exit full screen to show messages${unreadLabel}` : open ? "Collapse chat to the input bar" : `Show chat${unreadLabel}`;
    stripIcon.className = `ui-sprite ${open ? "ui-icon-strip-hide" : "ui-icon-strip-show"}`;
    unreadChip.textContent = unread > 99 ? "99+ new" : `${String(unread)} new`;
    unreadChip.hidden = open || unread === 0;
    // Collapsed in full screen the log is out of sight: no invisible tab stop.
    chatLog.root.tabIndex = !open && !strip.hidden ? -1 : 0;
    // Open, the key heads the strip; collapsed, it follows the field on the band. Focus stays on it either way.
    const home = open ? stripHead : strip;
    if (stripToggle.parentElement !== home || home.lastElementChild !== stripToggle) {
      const focused = document.activeElement === stripToggle;
      home.append(stripToggle);
      if (focused) stripToggle.focus({ preventScroll: true });
    }
  };
  /**
   * In a narrow strip (a phone held sideways) the emote and pop-out keys head the strip, so the field keeps its room
   * (OME-905); everywhere else they lead and end the chat row. Focus on either survives the move.
   */
  const placeRowKeys = (inHead: boolean): void => {
    if (picker.root.parentElement === (inHead ? stripHead : chatForm)) return;
    const focused = document.activeElement;
    picker.close();
    if (inHead) stripTitle.after(picker.root, popOut);
    else {
      chatForm.prepend(picker.root);
      chatForm.append(popOut);
    }
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
  };
  stripToggle.addEventListener("click", () => {
    stripMode = displayedStripMode === "open" ? "band" : "open";
    unread = 0;
    storeStrip(stripMode);
    renderStrip(stripMode);
    fit();
  });
  renderStrip();

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
    if (on) o.hint.dismiss();
    // Moving a focused field blurs it: give focus back to where it was (the draft is the same node, so it stays).
    const focused = document.activeElement;
    const wasInRoom = on && focused instanceof HTMLElement && clip.contains(focused);
    const restoreScroll = holdScroll();
    wrap.classList.toggle("is-fs", on);
    root.classList.toggle("room-fs", on);
    wrap.classList.toggle("is-pseudo-fs", mode === "pseudo");
    document.body.classList.toggle("room-is-pseudo-fs", mode === "pseudo");
    tvBox.setFullscreen(on);
    o.placeRoom();
    unread = 0;
    chatLog.setAgeing(on ? "fade" : "settle");
    fsChat.setActive(on);
    placeChat();
    setBehindInert(mode === "pseudo");
    setMirror(on);
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

  const dock = createPortraitDock({ root, log: chatLog.root, composer: chatForm,
    queue: queuePanel.root, queueLayout: (on) => { queuePanel.setPortrait(on); }, shelf: controls, pictureRegion: wrap, settings: o.settings, onViewport: () => { fit(); tvBox.place(); } });
  let portraitOn = false;
  // Wide: People takes the log's place in the chat column while open (OME-1805), never above the TV.
  // Portrait dock (a phone, or a tablet since OME-1802): under the picture, so the TV stays put and the room gives way.
  const placePeople = (two: boolean): void => {
    if (two && fs.mode() === "off") chatLog.root.before(o.people);
    else if (portraitOn) wrap.after(o.people);
    else o.roomTop.after(o.people);
  };
  const syncPortrait = (): boolean => {
    const on = o.portrait.matches && fs.mode() === "off" && o.stageShown();
    if (on === portraitOn) return false;
    portraitOn = on;
    dock.setActive(on);
    placePeople(wide.matches);
    return true;
  };
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
  let sideTabOn = false;
  // Tall, the owner's bar ends People inside its scroll while it's open (OME-1842: beside it, it left People ~110 px);
  // short, the column scrolls as one, the bar and Report room after People (OME-1841).
  const placeTabFoot = (): void => {
    if (!sideTabOn) return;
    // Only if it moves: a move resets the bar's focus and scroll.
    if (!o.short.matches && !o.people.hidden) {
      if (o.people.lastElementChild !== o.ownerBar) o.people.append(o.ownerBar);
    } else if (o.people.nextElementSibling !== o.ownerBar) o.people.after(o.ownerBar);
    // Short, the editor follows its Done key (OME-1927): under the room it was off-screen, the floor filling the column.
    if (o.short.matches && o.ownerBar.nextElementSibling !== o.editorPanel) o.ownerBar.after(o.editorPanel);
    if (o.short.matches && o.editorPanel.nextElementSibling !== o.foot) o.editorPanel.after(o.foot);
  };
  new MutationObserver(placeTabFoot).observe(o.people, { attributes: true, attributeFilter: ["hidden"] });
  // Classes, not .room-side:has(): that re-styled the column on every chat line put in its log (OME-1985).
  const markSide = (): void => {
    side.classList.toggle("people-open", o.people.parentElement === side && !o.people.hidden);
    side.classList.toggle("poll-open", o.poll.parentElement === side && !o.poll.hidden);
  };
  const sideWatch = new MutationObserver(markSide);
  sideWatch.observe(side, { childList: true });
  for (const e of [o.people, o.poll]) sideWatch.observe(e, { attributes: true, attributeFilter: ["hidden"] });
  /** On a phone the chat follows the room straight away, on screen and in focus order; elsewhere it's under the notices. */
  const placeChat = (): void => {
    dock.close();
    syncPortrait();
    const two = wide.matches;
    root.classList.toggle("room-wide", two);
    // room.css's page rules key on this, not body:has(): that re-styled the page on every chat line (OME-1755).
    document.body.classList.toggle("room-is-wide", two);
    side.hidden = !two;
    // Wide: the room's placeholder, the invite and Up next head the chat column; otherwise they're back in the page's flow.
    // Short (a phone held sideways, OME-1595): the head row and the invite's Copy key share the column's first row, so
    // the left column's height goes to the picture and the floor.
    if (two && o.short.matches) {
      side.prepend(roomAway, o.roomTop, queuePanel.root);
      o.roomTop.prepend(invite);
    } else root.prepend(o.roomTop);
    // Short and wide, the foot gives the room window its row too (OME-1841): it ends the People tab instead (below).
    if (o.foot.parentElement === side) side.after(o.foot);
    if (two && !o.short.matches) side.prepend(roomAway, invite, queuePanel.root);
    else if (!two) {
      wrap.after(roomAway);
      notice.after(invite);
      tvBox.personal.after(queuePanel.root);
    }
    // Wide, the owner's bar ends the People tab (below, OME-1842): under the stage it cost the owner half the room
    // (OME-1301), above People it left People ~110 px. Short, Report room joins it (OME-1841). Full screen, under Up next.
    const sideTab = two && fs.mode() === "off";
    if (o.editorPanel.parentElement === side && !(sideTab && o.short.matches)) wrap.after(o.editorPanel);
    if (two && !sideTab) queuePanel.root.after(o.ownerBar);
    else if (!sideTab) o.editorPanel.before(o.ownerBar);
    if (fs.mode() !== "off") stripHead.after(o.poll, chatLog.root, chatForm, chatAway);
    else if (two) side.append(o.poll, chatLog.root, chatForm, chatAway);
    else if (phone.matches) wrap.after(o.poll, chatLog.root, chatForm, chatAway);
    else notice.after(o.poll, chatLog.root, chatForm, chatAway);
    placePeople(two);
    sideTabOn = sideTab;
    placeTabFoot();
    if (portraitOn) chatForm.before(dock.keys);
    // Set (k): every key and field is at least 44×44 CSS px to the finger (reference.css .ui-touch): the phone layout
    // (a narrow mouse window too) or a touch screen held sideways (QA OME-1324 G1/G2).
    root.classList.toggle("ui-touch", phone.matches || o.coarse.matches);
  };
  placeChat();

  /** The phone's window looks at the middle of the seats, the band at the audience's (OME-1843; the seats' where it can't hold them all, OME-1864), until you drag it, sit, or focus something off-screen. */
  const roomWindow = createRoomWindow(clip, stage, (w, h, band) => (band ? bandHome(seatPoints, standingPoints, { w, h }, me) : touchHome(seatPoints, me, { w, h })), o.labelScale, o.bubbleSides);
  let seatPoints: readonly Point[] = [];
  /** The standing spots: with the seats, where members are. */
  let standingPoints: readonly Point[] = [];
  let me: Point | null = null;
  /** The desktop band's fit (OME-2148): its inputs and scale, null in every other layout. */
  let band: { readonly scale: number; readonly h: number; readonly k: number } | null = null;
  let fsScrollWidth = -1;
  let fsScrollHeight = -1;
  let fsScrollTarget = -1;
  /** The TV and its shelf take their boxes, compact where they're small. */
  /** `zoom`: the wide page's chrome zoom (OME-1667); the shelf's and the moments strip's boxes are in their own, zoomed, px. */
  const boxTv = (l: { readonly tv: Rect; readonly controls: Rect; readonly compact: { readonly tv: boolean; readonly controls: boolean } }, height: number, fsAt?: FullscreenLayout["at"], zoom = 1): void => {
    const z = (r: Rect): Rect => (zoom === 1 ? r : { x: r.x / zoom, y: r.y / zoom, w: r.w / zoom, h: r.h / zoom });
    const zoomed = zoom === 1 ? "" : String(zoom);
    box(tv, l.tv);
    box(controls, z(l.controls));
    controls.style.zoom = zoomed;
    if (o.moments !== undefined) {
      const m = momentsBox({ tv: z(l.tv), controls: z(l.controls) }, height / zoom, fsAt);
      o.moments.classList.toggle("no-room", m === null);
      o.moments.style.zoom = zoomed;
      if (m !== null) box(o.moments, m);
    }
    tv.classList.toggle("compact", l.compact.tv);
    controls.classList.toggle("compact", l.compact.controls);
  };
  const fit = (): void => {
    band = null;
    const roomOut = o.roomOut();
    // Only the wide layout's touch window (below) stretches the wrap; only its desktop band bleeds (OME-1843).
    wrap.style.minHeight = "";
    clip.classList.remove("is-bleed");
    // Set before the wrap is measured: room.css widens the chat column with it.
    const zoom = wide.matches && fs.mode() === "off" ? chromeZoom(window.innerWidth, window.innerHeight) : 1;
    // The body too: room.css sizes the page's chat column from it (a body class, never body:has(), OME-1755).
    for (const e of [root, document.body]) {
      if (zoom === 1) delete e.dataset["chrome"];
      else e.dataset["chrome"] = String(zoom);
    }
    if (fs.mode() !== "off") {
      // The room popped out: its chat is in the window, so the picture is alone.
      const l = fullscreenLayout(wrap.clientWidth, wrap.clientHeight, tvBox.provider(), fsChat.hidden() ? "hidden" : roomOut ? "none" : stripMode);
      boxTv(l, wrap.clientHeight, l.at);
      box(fsChat.bubbles, l.strip);
      // The hide/show-chat handle (OME-1593): on the strip's edge, or the screen's while hidden; none on the band.
      fsChat.pill.hidden = l.handle === undefined;
      if (l.handle !== undefined) {
        box(fsChat.pill, l.handle);
        fsChat.toggle.textContent = HANDLE_ARROWS[l.handle.arrow];
      }
      box(strip, l.strip);
      strip.dataset["at"] = l.at;
      renderStrip(l.at === "band" ? "band" : stripMode);
      placeRowKeys(l.at === "side" && l.strip.w < FS_STRIP_W);
      const scrollTransport = l.at === "band" && l.compact.controls;
      controls.classList.toggle("scroll-transport", scrollTransport);
      controls.tabIndex = scrollTransport ? 0 : -1;
      controls.ariaLabel = scrollTransport ? "Playback controls; scroll horizontally for more" : "Playback controls";
      wrap.style.height = "";
      const scrollY = l.scrollY ?? 0;
      wrap.dataset["fsScroll"] = String(scrollY > 0);
      // Layout changes expose the composer. An unchanged fit must preserve a user's scroll to the player.
      if (fsScrollTarget !== scrollY || fsScrollWidth !== wrap.clientWidth || fsScrollHeight !== wrap.clientHeight) {
        wrap.scrollTop = scrollY;
        fsScrollTarget = scrollY;
        fsScrollWidth = wrap.clientWidth;
        fsScrollHeight = wrap.clientHeight;
      }
      return;
    }
    delete wrap.dataset["fsScroll"];
    wrap.scrollTop = 0;
    fsScrollWidth = fsScrollHeight = fsScrollTarget = -1;
    placeRowKeys(false);
    controls.classList.remove("scroll-transport");
    controls.tabIndex = -1;
    controls.ariaLabel = "Playback controls";
    if (wide.matches) {
      // The chat column follows the visual viewport (OME-1297): an on-screen keyboard that keeps the layout viewport
      // (iOS) never covers the field. Not under a pinch zoom, where the column stays put.
      const v = window.visualViewport ?? null;
      const follow = v !== null && v.scale === 1;
      side.style.top = follow ? `${String(v.offsetTop)}px` : "";
      side.style.height = follow ? `${String(Math.min(v.height, window.innerHeight))}px` : "";
      side.classList.toggle("is-typing", follow && window.innerHeight - v.height > 100);
      // The left column's box sizes it all (the wrap flexes to what the column has left), so the page never scrolls.
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      // The room popped out: the picture has the column (its placeholder is in the chat column).
      const l = roomOut ? fullscreenLayout(w, h, tvBox.provider(), "none") : wideLayout(w, h, tvBox.provider(), zoom, roomScale(window.innerWidth, window.innerHeight));
      boxTv(l, h, undefined, roomOut ? 1 : zoom);
      if ("stage" in l) {
        // A touch screen whose band can't hold the room at its scale (a phone held sideways) gets the phone's window: seats
        // scaled to a third were 15×8 px (QA OME-1324 G1). It takes the column's width and what the TV leaves (windowH:
        // the keys beside it in a row, OME-1841); where that's too little (Twitch's taller TV, QA OME-1330 R1) the keys'
        // column height, so every seat row shows whole beside the keys; the wrap grows to hold it and the column scrolls.
        if (o.coarse.matches && (l.stage.w < ROOM_VIEW.w * l.scale || l.stage.h < ROOM_VIEW.h * l.scale)) {
          const rw = Math.min(w, STAGE_W);
          // Where the wrap leaves too little (844×390, OME-1929), to the column's foot: what plays under the wrap (the
          // reaction bar) is reached by scrolling, as it is when it shows after the fit; fitted with it there, the window
          // lost 34 px and took the keys' column. Where the wrap holds the window, its foot: the reaction keys stay on screen
          // under it (1024×768 t as owner, OME-1944).
          const foot = root.clientHeight - (wrap.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop);
          const bottom = h - l.stage.y >= windowMinH(rw) ? h : Math.max(h, foot);
          const r = { x: 0, y: l.stage.y, w: rw, h: windowH(rw, Math.min(PHONE_ROOM_H, bottom - l.stage.y)) };
          wrap.style.minHeight = `${String(r.y + r.h)}px`;
          box(clip, r);
          stage.style.setProperty("--stage-scale", "1");
          roomWindow.set(true, r.w, r.h);
        } else {
          // With a video the room fits the band (OME-2148, ADR 0060): the back wall's art to the lowest name tag, below 1×
          // if it must. Without one the room isn't a band and keeps its whole scale (OME-1811).
          const video = tvBox.provider() !== null;
          const k = video ? bandFit(l.scale, l.stage.h, [...seatPoints, ...standingPoints], me) : l.scale;
          const sw = Math.min(l.stage.w, ROOM_VIEW.w * k);
          const r = { x: Math.floor((w - sw) / 2), y: l.stage.y, w: sw, h: l.stage.h };
          box(clip, r);
          // The band's backdrop and dim reach the column's edges (OME-1843): no island in a column wider than the room.
          clip.classList.toggle("is-bleed", r.w < w);
          clip.style.setProperty("--bleed", `${String(Math.ceil((w - r.w) / 2))}px`);
          roomWindow.set(false, 0, 0);
          roomWindow.desk(k, r);
          stage.style.setProperty("--stage-scale", String(k));
          band = video ? { scale: l.scale, h: l.stage.h, k } : null;
        }
      }
      wrap.style.height = "";
      return;
    }
    const onPhone = phone.matches;
    const l = portraitOn
      ? portraitLayout(wrap.clientWidth, wrap.clientHeight, tvBox.provider(), root.classList.contains("portrait-typing"))
      : roomLayout(wrap.clientWidth, tvBox.provider(), onPhone);
    boxTv(l, roomOut ? l.stage.y : l.height);
    if (portraitOn) {
      root.style.setProperty("--portrait-picture-height", `${String(l.tv.y + l.tv.h)}px`);
      root.style.setProperty("--portrait-sheet-top", `${String(Math.min(tv.getBoundingClientRect().bottom, wrap.getBoundingClientRect().bottom))}px`);
    }
    box(clip, l.stage);
    // room.css sizes the host's tag hit areas by it; the phone window keeps its own zoom.
    stage.style.setProperty("--stage-scale", String(onPhone ? 1 : l.scale));
    if (onPhone) roomWindow.set(true, l.stage.w, l.stage.h);
    else {
      roomWindow.set(false, 0, 0);
      roomWindow.desk(l.scale);
    }
    // The room popped out: the wrap ends where the stage would start, and the placeholder follows it.
    wrap.style.height = portraitOn ? "" : `${String(roomOut ? l.stage.y : l.height)}px`;
  };
  /** Layout first, then the open quality tray follows its key. */
  new ResizeObserver(() => {
    fit();
    tvBox.place();
  }).observe(wrap);
  fit();

  return {
    fs,
    fsChat,
    strip,
    fit,
    placeChat,
    holdScroll,
    syncPortrait,
    portraitOn: () => portraitOn,
    dock,
    seats: (points, standing) => {
      seatPoints = points;
      standingPoints = standing;
      // The band too (OME-1843): its first fit came before the layout, so it looked at the stage's middle.
      fit();
    },
    centre: (p) => {
      roomWindow.centre(p);
    },
    me: (p) => {
      if (p?.x === me?.x && p?.y === me?.y) return;
      me = p;
      // The band's fit holds my name tag too (OME-2148): a spot that changes it refits, any other just looks again.
      if (band !== null && bandFit(band.scale, band.h, [...seatPoints, ...standingPoints], me) !== band.k) fit();
      else roomWindow.rehome();
    },
    missed: () => {
      if (displayedStripMode !== "band" || fs.mode() === "off") return;
      unread++;
      renderStrip();
    },
  };
}
