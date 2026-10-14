// Where the room page's pieces sit (split out of room.ts, OME-1100): the page, the wide column (OME-642), the phone
// (OME-596) and its portrait dock (OME-905), and full screen with its chat strip (OME-597). It moves nodes and sizes
// boxes; it never builds what it places.
import type { ChatLog } from "./chat/log";
import { el, sprite } from "./controls/dom";
import type { QueuePanel } from "./controls/queue-panel";
import { createFullscreen, type Fullscreen, type FullscreenMode } from "./fullscreen";
import { FS_STRIP_W, STAGE_H, STAGE_W, fullscreenLayout, portraitLayout, roomLayout, stageTransform, wideLayout, type Point, type Rect, type StripMode } from "./layout";
import { createPortraitDock } from "./portrait-dock";
import { createRoomWindow } from "./room-window";
import type { RoomTv } from "./room-tv";

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

export interface RoomLayoutOptions {
  /** The room page (opts.root), with every piece below already in it. */
  readonly root: HTMLElement;
  /** The full-screen element: the TV, its shelf and the stage's window. */
  readonly wrap: HTMLElement;
  readonly clip: HTMLElement;
  readonly stage: HTMLElement;
  readonly tv: RoomTv;
  readonly log: ChatLog;
  /** The chat row, its pop-out placeholder, and the keys that lead and end the row. */
  readonly composer: {
    readonly form: HTMLFormElement;
    readonly away: HTMLElement;
    readonly popOut: HTMLElement;
    readonly picker: { readonly root: HTMLElement; close(): void };
  };
  readonly queue: QueuePanel;
  readonly notice: HTMLElement;
  /** The room's pop-out placeholder. */
  readonly roomAway: HTMLElement;
  readonly invite: HTMLElement;
  /** The wide layout's right-hand column. */
  readonly side: HTMLElement;
  /** What the portrait dock's settings sheet holds. */
  readonly settings: readonly HTMLElement[];
  readonly phone: { readonly matches: boolean };
  readonly portrait: { readonly matches: boolean };
  readonly wide: { readonly matches: boolean };
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
  /** The seats moved (a new layout): the phone's window looks at their middle. */
  readonly seats: (points: readonly Point[]) => void;
  /** I sat down: the phone's window centres on my seat. */
  readonly centre: (p: Point) => void;
  /** A line from someone else came in: counted while the strip is collapsed in full screen. */
  readonly missed: () => void;
}

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
    wrap.classList.toggle("is-pseudo-fs", mode === "pseudo");
    tvBox.setFullscreen(on);
    o.placeRoom();
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

  const dock = createPortraitDock({ root, log: chatLog.root, composer: chatForm,
    queue: queuePanel.root, queueLayout: (on) => { queuePanel.setPortrait(on); }, shelf: controls, pictureRegion: wrap, settings: o.settings, onViewport: () => { fit(); tvBox.place(); } });
  let portraitOn = false;
  const syncPortrait = (): boolean => {
    const on = o.portrait.matches && fs.mode() === "off" && o.stageShown();
    if (on === portraitOn) return false;
    portraitOn = on;
    dock.setActive(on);
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
  /** On a phone the chat follows the room straight away, on screen and in focus order; elsewhere it's under the notices. */
  const placeChat = (): void => {
    dock.close();
    syncPortrait();
    const two = wide.matches;
    root.classList.toggle("room-wide", two);
    side.hidden = !two;
    // Wide: the room's placeholder, the invite and Up next head the chat column; otherwise they're back in the page's flow.
    if (two) side.prepend(roomAway, invite, queuePanel.root);
    else {
      wrap.after(roomAway);
      notice.after(invite);
      tvBox.personal.after(queuePanel.root);
    }
    if (fs.mode() !== "off") stripHead.after(chatLog.root, chatForm, chatAway);
    else if (two) side.append(chatLog.root, chatForm, chatAway);
    else if (phone.matches) wrap.after(chatLog.root, chatForm, chatAway);
    else notice.after(chatLog.root, chatForm, chatAway);
    if (portraitOn) chatForm.before(dock.keys);
    // Set (k): every key and field is at least 44×44 CSS px to the finger (reference.css .ui-touch).
    root.classList.toggle("ui-touch", phone.matches);
  };
  placeChat();

  /** The phone's window looks at the middle of the seats until you drag it, sit, or focus something off-screen. */
  const roomWindow = createRoomWindow(clip, stage, () => seatsMiddle);
  let seatsMiddle: Point = { x: STAGE_W / 2, y: STAGE_H / 2 };
  let fsScrollWidth = -1;
  let fsScrollHeight = -1;
  let fsScrollTarget = -1;
  const fit = (): void => {
    const roomOut = o.roomOut();
    if (fs.mode() !== "off") {
      // The room popped out: its chat is in the window, so the picture is alone.
      const l = fullscreenLayout(wrap.clientWidth, wrap.clientHeight, tvBox.provider(), roomOut ? "none" : stripMode);
      box(tv, l.tv);
      box(controls, l.controls);
      box(strip, l.strip);
      strip.dataset["at"] = l.at;
      renderStrip(l.at === "band" ? "band" : stripMode);
      placeRowKeys(l.at === "side" && l.strip.w < FS_STRIP_W);
      tv.classList.toggle("compact", l.compact.tv);
      controls.classList.toggle("compact", l.compact.controls);
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
    controls.classList.toggle("scroll-transport", portraitOn);
    controls.tabIndex = -1;
    controls.ariaLabel = "Playback controls";
    if (wide.matches) {
      // The left column's box sizes it all (the wrap flexes to what the column has left), so the page never scrolls.
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      // The room popped out: the picture has the column (its placeholder is in the chat column).
      const l = roomOut ? fullscreenLayout(w, h, tvBox.provider(), "none") : wideLayout(w, h, tvBox.provider());
      box(tv, l.tv);
      box(controls, l.controls);
      tv.classList.toggle("compact", l.compact.tv);
      controls.classList.toggle("compact", l.compact.controls);
      if ("stage" in l) {
        box(clip, l.stage);
        roomWindow.set(false, 0, 0);
        stage.style.transform = stageTransform(l.scale);
      }
      wrap.style.height = "";
      return;
    }
    const onPhone = phone.matches;
    const l = portraitOn
      ? portraitLayout(wrap.clientWidth, wrap.clientHeight, tvBox.provider(), root.classList.contains("portrait-typing"))
      : roomLayout(wrap.clientWidth, tvBox.provider(), onPhone);
    box(tv, l.tv);
    box(controls, l.controls);
    tv.classList.toggle("compact", l.compact.tv);
    controls.classList.toggle("compact", l.compact.controls);
    if (portraitOn) {
      root.style.setProperty("--portrait-picture-height", `${String(l.tv.y + l.tv.h)}px`);
      root.style.setProperty("--portrait-sheet-top", `${String(Math.min(tv.getBoundingClientRect().bottom, wrap.getBoundingClientRect().bottom))}px`);
      controls.classList.add("scroll-transport");
      controls.tabIndex = 0;
      controls.ariaLabel = "Playback controls; scroll horizontally for more";
    }
    box(clip, l.stage);
    if (onPhone) roomWindow.set(true, l.stage.w, l.stage.h);
    else {
      roomWindow.set(false, 0, 0);
      stage.style.transform = stageTransform(l.scale);
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
    strip,
    fit,
    placeChat,
    holdScroll,
    syncPortrait,
    portraitOn: () => portraitOn,
    dock,
    seats: (points) => {
      seatsMiddle = middleOf(points);
      if (phone.matches) fit();
    },
    centre: (p) => {
      roomWindow.centre(p);
    },
    missed: () => {
      if (displayedStripMode !== "band" || fs.mode() === "off") return;
      unread++;
      renderStrip();
    },
  };
}
