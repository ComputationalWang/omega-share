// Room screen. Loaded lazily after Enter so PixiJS stays out of the initial bundle.
// The room chrome (OME-1023): Vite loads this stylesheet before the chunk resolves, so the room never paints unstyled.
import "./room.css";
import "pixi.js/unsafe-eval";
// Pixi's browser environment, which Application.init would otherwise fetch as its own chunk after Join (OME-2073).
import "pixi.js/browser";
import { DEFAULT_LAYOUT, MAX_ROOM_MEMBERS, REACTIONS_MAX, type Accessory, type Avatar, type ClientMessage, type EmoteKind, type FloorCell, type Hair, type Member, type MemberId, type Nickname, type Reaction, type ResumeToken, type RoomId, type RoomLayout, type RoomState, type Tint } from "@omega/shared";
import { browserNow, createClockSync } from "./clock";
import { createConnection, type Connection } from "./connection";
import { browserSocket, stoppedConnection } from "./room-socket";
import { trackShareToken } from "./share-token";
import { clearResume, handOffResume, loadResume, saveResume, takeHandOff, type ResumeStore } from "./session-record";
import { presenceHint } from "./session-lifecycle";
import { routeConnectionEvent, type RoomEventSinks } from "./room-events";
import { inviteLink, joinMessage, loadRoomSecrets, retitleRoom, type RoomSecret, type SecretsStore } from "./room-secrets";
import { createInviteControl } from "./controls/invite";
import { el, sprite } from "./controls/dom";
import { createSoundKey } from "./controls/sound-key";
import { snapRoom } from "./snap";
import { createPlaybackController, type PlaybackView } from "./controls/playback";
import { createRoomTv } from "./room-tv";
import { expectedPosition } from "./sync";
import { createReplay } from "./moments/replay";
import { createMomentsStrip } from "./moments/strip";
import { createRecapCard, recapOf } from "./moments/recap";
import { qualityMemory } from "./controls/quality";
import { createQueuePanel } from "./controls/queue-panel";
import { ERROR_TEXT, STATUS_TEXT, chatView } from "./controls/feedback";
import { bouncedUntil, kickedUntil, rememberKick } from "./kick-memory";
import { chatIntent, createWalkGate, floorSitIntent, lieIntent, sitIntent, stepAllowed, stepCell, walkIntent, walkOverIntent } from "./intents";
import { doorAt, layoutOf } from "./furniture";
import { createDoorChip } from "./door-chip";
import { createPendingApplier, stashVia, takeVia } from "./pending-layout";
import { PHONE_QUERY, PORTRAIT_QUERY, SHORT_QUERY, STAGE_W, WIDE_QUERY, type Point, type Rect } from "./layout";
import { createRoomLayout } from "./room-layout";
import { createStage, type Stage } from "./stage";
import { controlHeld, controlPolicy, initialState, nextExpiry, reduce, screen, type ViewEvent, type ViewState } from "./state";
import type { ExtensionBridge } from "./extension-bridge";
import { createOwnerTools } from "./owner-tools";
import { createEmotePicker } from "./emote/picker";
import { createEmoteBucket } from "./emote/emotes";
import { createReactionBar } from "./reactions/bar";
import { createCommandPalette } from "./chat/palette";
import { createChatLog } from "./chat/log";
import { logEntries } from "./chat/feed";
import { createPollCard, type PollView } from "./chat/poll";
import { CONGA_FULL_LINE, DANCE_SEATED_LINE, HUG_USAGE_LINE, POLL_USAGE_LINE, ROLL_USAGE_LINE, SIT_NO_CELL_LINE, chatSticker, createStickerGate, helpLine, pairInvitedLine, rollSticker, slashCommand } from "./chat/effects";
import { hugHint, hugStep, matchMember } from "./chat/hug";
import { cellOf as cellIndex, colOf, rowOf, walkGrid } from "./walk/path";
import { isPetting, petArrival, petSpot } from "./walk/pet";
import { attachMentionComplete } from "./chat/complete";
import { mentionOptions } from "./chat/mention";
import type { SystemLine } from "./controls/sysline";
import { createOutfitSlots } from "./outfits/slots";
import { chatKey } from "./chat/enter";
import { createTypingSender } from "./chat/typing";
import { browserChannel, channelName, popoutSupported, popoutUrl, randomId, roomPopoutUrl, type PopState } from "./popout/channel";
import { createChatRelay, type ChatRelay } from "./popout/relay";
import { createRoomCards } from "./room-cards";
import { createHelp, type SoundSetting } from "./help/dialog";
import { createCinemaDim } from "./cinema";
import { createCountdown } from "./countdown/countdown";
import { createHints } from "./help/hints";
import { createHiddenMembers } from "./hide/hidden";
import { createPeople } from "./hide/people";
import tintsJson from "../../../assets/avatars/tints.json";
import { createAccessorySection } from "./controls/accessory-section";
import { createHairSection, createTintSection } from "./controls/tint-section";
import { saveAccessory, saveHair, saveTint } from "./profile";
import { AVATAR_HAIRS, AVATAR_IDS, parseTints } from "./walk/tint";
import { followStep } from "./walk/follow";
import { NO_CONGA, congaAhead, congaJoin, congaStep, congaText } from "./chat/conga";
import { createPads } from "./walk/pad";
import { createApplause } from "./emote/applause";
import { NOT_FOUND_TITLE, roomPageTitle } from "./page-title";
import type { FloorKind, Sound } from "./audio";
import { cellAt } from "./walk/path";

export interface RoomOptions {
  readonly root: HTMLElement;
  readonly roomId: RoomId;
  readonly socketUrl: string;
  readonly nickname: Nickname;
  readonly avatar: Avatar;
  /** Shirt tint to join with (ADR 0053, the profile's). */
  readonly tint: Tint;
  /** Accessory to join with (OME-1391, the profile's). */
  readonly accessory: Accessory;
  /** Hair colour to join with (OME-1438, the profile's). */
  readonly hair: Hair;
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
  /** Where a member's bubbles and sticker hang now (stage.ts `head`), for e2e seated-height checks. */
  readonly head: (id: MemberId) => Point | undefined;
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
  /** How many crowd-applause confetti bursts played (OME-1389), for e2e. */
  readonly confetti: () => number;
  /** The furniture loops running now (room-view.ts `loops`, OME-1407), for e2e. */
  readonly furnitureLoops: () => ReturnType<Stage["view"]["loops"]>;
  /** The wandering cats (room-view.ts `cats`, OME-1520), for e2e. */
  readonly cats: () => ReturnType<Stage["view"]["cats"]>;
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
  // Cinema dim (OME-1406): this device's setting, from localStorage (the getter itself throws when storage is blocked).
  const cinema = createCinemaDim({
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => {
      localStorage.setItem(k, v);
    },
  });
  // /hug and /highfive (OME-1453): the walk over that's on its way, and the emote it ends with once I've stopped there.
  // `tries`: how often a /pet walk re-targeted a cat that moved on (OME-1704).
  let hug: { readonly target: MemberId | null; readonly cell: FloorCell; readonly kind: EmoteKind; arrived: boolean; readonly tries?: number } | null = null;
  function hugNow(): void {
    const h = hug;
    hug = null;
    if (h === null) return;
    // The cat may have wandered while I walked: only a heart from beside it is a pet, so chase it or say so.
    const self = state.self;
    const me = h.target === null && self !== null ? (state.room?.members.find((m) => m.id === self)?.cell ?? roomStage.cellOf(self)) : null;
    const tries = h.tries ?? 0;
    const step = me === null ? "pet" : petArrival(cellIndex(me.x, me.y), roomStage.catCells(), tries);
    if (step === "pet") picker.emote(h.kind);
    else if (step === "retarget") startPet(tries + 1);
    else hint(hugHint("The cat wandered off"));
  }
  // Room sounds (OME-1638): the engine is its own lazy chunk, loaded once the room is up; until then nothing sounds.
  let sound: Sound | null = null;
  const roomStage: Stage = await createStage({
    reducedMotion,
    sound: {
      pose: (id, p) => {
        sound?.pose(id, p);
      },
      play: (name) => {
        sound?.play(name);
      },
    },
    roomId: opts.roomId,
    serverNow: () => clock.serverNow(),
    dim: cinema.el,
    onMove: (id) => {
      if (id === state.self) closeWheel();
    },
    onStop: (id) => {
      if (id === state.self && hug?.arrived === true) hugNow();
      const room = state.room;
      if (id === state.self && room?.layout !== undefined) pads.stopped(room.layout, room.members.find((m) => m.id === id)?.cell);
    },
    requestRender: () => {
      requestRender();
    },
    onLayout: (seats, standing) => {
      layout.seats(seats, standing);
    },
    onFloor: (cell, run) => {
      // A tap on a cat's cell pets it (OME-1669); a cat's cell isn't somewhere to walk anyway.
      if (roomStage.catCells().includes(cellIndex(cell.x, cell.y))) return startPet();
      quitConga();
      stopFollow();
      return walkTo(cell, run);
    },
    onStep: (key, repeat, run) => {
      quitConga();
      stopFollow();
      const now = performance.now();
      if (!stepAllowed(repeat, now, lastStep, run)) return true;
      // From where I'm headed (my cell), else where I'm drawn (a seat, my standing spot).
      const me = state.room?.members.find((m) => m.id === state.self);
      const from = me?.cell ?? (state.self === null ? null : roomStage.cellOf(state.self));
      const to = from === null ? null : stepCell(from, key);
      if (to === null) return from === null;
      lastStep = now;
      return walkTo(to, run);
    },
    onSit: () => {
      floorSit();
    },
  });
  /** `/sit`, "Sit here" or S (OME-1501): sit on the floor of my cell or get up; with no cell under me, say so. */
  function floorSit(): boolean {
    const msg = floorSitIntent(state);
    if (msg === "no-cell") {
      hint(SIT_NO_CELL_LINE);
      return true;
    }
    if (msg === null) return false;
    // Following walks me on their next walk, which would get me up again.
    stopFollow();
    return send(msg);
  }
  /** Free walking (OME-1350): send `walk` to free floor; false (the floor flashes) when nobody can stand there. */
  function walkTo(cell: FloorCell, run: boolean): boolean {
    const msg = walkIntent(state, cell, run);
    if (msg === "blocked") return false;
    if (msg !== null) walkGate.push(msg);
    return true;
  }
  /** Walk over (OME-1376): the member menu's and the People list's key; null (disabled) with no free cell beside them. */
  function walkOver(id: MemberId): (() => void) | null {
    const msg = walkOverIntent(state, id, (m) => roomStage.cellOf(m));
    return msg === null ? null : () => {
      walkGate.push(msg);
    };
  }
  // Follow (OME-1389): who I follow, and the "Following Sam · Stop" chip over the room window.
  let following: MemberId | null = null;
  const followName = el("span");
  const followStopKey = el("button", { type: "button", className: "ui-button secondary", textContent: "Stop" }, "follow-stop");
  const followChip = el("div", { className: "ui-chip follow-chip", role: "status", hidden: true }, "follow-chip");
  followChip.append(followName, " · ", followStopKey);
  function stopFollow(): void {
    if (following === null) return;
    following = null;
    followChip.hidden = true;
  }
  function follow(id: MemberId): void {
    const nickname = state.room?.members.find((m) => m.id === id)?.nickname;
    if (id === state.self || nickname === undefined) return;
    following = id;
    followName.textContent = `Following ${nickname}`;
    followChip.hidden = false;
    walkOver(id)?.();
  }
  followStopKey.addEventListener("click", () => {
    quitConga();
    stopFollow();
  });
  // /conga (OME-1564): the line every client derives from the relayed `/conga` and `/stop` lines; on mine, I Follow the
  // one before me. `congaFollows` is whom the line has me follow; `congaQuit`, a `/stop` of mine not back yet (sent once).
  let conga = NO_CONGA;
  let congaFollows: MemberId | null = null;
  let congaQuit = false;
  function congaFollow(): void {
    const ahead = congaAhead(conga, state.self);
    if (ahead === null) congaQuit = false;
    if (congaQuit) return;
    if (congaFollows !== null && ahead !== congaFollows && following === congaFollows) stopFollow();
    congaFollows = ahead;
    // Not only when the line changes: a resume stops Follow on an unchanged line (QA OME-1570). Leaving on purpose
    // goes through quitConga or the prune.
    if (ahead !== null && following !== ahead && state.status === "open") follow(ahead);
  }
  /** Walking off, a hug, another Follow or the chip's Stop: a follower leaves the line by a `/stop` line, so every client closes it up. */
  function quitConga(): void {
    if (congaFollows !== null && !congaQuit) congaQuit = send({ type: "chat", text: "/stop" });
  }
  // Teleport pads (OME-1548): the teleport itself goes out unthrottled (one per 400 ms stand); every walk of mine, held
  // by the gate or not, takes a pending one back and arms the next stop.
  const pads = createPads({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
    send: (m) => send(m),
  });
  const gate = createWalkGate({
    now: () => performance.now(),
    send: (m) => send(m),
    setTimer: (fn, ms) => setTimeout(fn, ms),
  });
  const walkGate = {
    push(m: ClientMessage): void {
      pads.walkSent();
      gate.push(m);
    },
    cancel(): void {
      pads.cancel();
      gate.cancel();
    },
  };
  let lastStep = -Infinity;
  const { root: stage, overlay, tags, view } = roomStage;
  const clip = el("div", { className: "stage-clip" }, "room-window");
  // Doors (OME-1425): standing in front of one (not sitting) offers "Go to <room> · Stay". The title is the saved one, read
  // on arrival; the cell is only looked at when my cell or the layout changes.
  // The `sessionStorage` getter itself throws when storage is blocked; stashVia and takeVia catch it.
  const viaStore = {
    getItem: (k: string) => sessionStorage.getItem(k),
    setItem: (k: string, value: string) => {
      sessionStorage.setItem(k, value);
    },
    removeItem: (k: string) => {
      sessionStorage.removeItem(k);
    },
  };
  const doorChip = createDoorChip({
    titleOf: (id) => {
      try {
        return loadRoomSecrets(localStorage).rooms[id]?.title ?? null;
      } catch {
        return null;
      }
    },
    go: (path, target) => {
      // The room I leave, for the door's room to put me at its door back here (OME-1558); never in the URL.
      stashVia(viaStore, target, opts.roomId);
      location.assign(path);
    },
  });
  let doorCell = "";
  let doorLayout: RoomLayout | null = null;
  const updateDoorChip = (s: RoomState | null, self: MemberId | null, l: RoomLayout): void => {
    const me = s === null || self === null ? undefined : s.members.find((m) => m.id === self);
    const cell = me?.cell !== undefined && s?.seats.includes(me.id) === false ? me.cell : null;
    const key = cell === null ? "" : `${String(cell.x)},${String(cell.y)}`;
    if (key === doorCell && l === doorLayout) return;
    doorCell = key;
    doorLayout = l;
    doorChip.at(cell === null ? null : doorAt(l, cell.x, cell.y));
  };
  clip.append(stage, followChip, doorChip.root);
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
    send: (m) => {
      if (m.type === "ended") showRecap(m.itemId);
      return send(m);
    },
    clock,
    now: () => performance.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => {
      clearInterval(h);
    },
    onView: (v) => {
      pbView = v;
      if (v.duration !== momentsDuration) {
        momentsDuration = v.duration;
        drawMoments();
      }
      strip.setControl(v.canControl && !v.held && !v.live);
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
    // Upright on a phone the field is in the Up next sheet: the composer's Link key opens it with the field focused.
    onCurtain: () => {
      if (layout.portraitOn()) layout.dock.link.click();
      else queuePanel.root.querySelector("input")?.focus();
    },
  });
  const { tv, controls } = tvBox;
  // Moments (OME-1628): the current item's reactions, as the strip under the shelf and the late joiner's replay.
  let reactions: Reaction[] = [];
  let momentsDuration = 0;
  const strip = createMomentsStrip({ seek: (s) => playback.seek(s) });
  const drawMoments = (): void => {
    strip.render(reactions, momentsDuration * 1000);
  };
  const replay = createReplay({
    position: () => {
      const pb = state.room?.playback;
      return pb == null || !pb.playing || pbView?.live === true ? null : { ms: expectedPosition(pb, clock.serverNow()) * 1000, rate: pb.rate };
    },
    show: (id, kind) => {
      if (!isHidden(id)) emoted(id, kind);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => {
      clearTimeout(h);
    },
  });
  wrap.append(tv, controls, strip.root, clip);
  // One local bucket for emotes and reactions: the server charges both to the emote limit (OME-1631).
  const emoteBucket = createEmoteBucket(performance.now());
  // The reaction bar (OME-1631) under the room and its TV, while something plays.
  const reactionBar = createReactionBar({
    bucket: emoteBucket,
    send: (m) => send(m),
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  });
  // Recap (OME-1629): once per item, when it ends or the queue moves on; who watched = everyone in the room during it.
  const recap = createRecapCard();
  const watched = new Map<string, Nickname>();
  let recapped: string | undefined;
  const see = (members: readonly Member[] | undefined): void => {
    for (const m of members ?? []) watched.set(m.id, m.nickname);
  };
  const showRecap = (id: string | undefined): void => {
    if (id === undefined || id === recapped) return;
    recapped = id;
    const d = recapOf(reactions, momentsDuration * 1000, [...watched].filter(([m]) => !isHidden(m)).map(([, n]) => n));
    if (d !== null) recap.show(d);
  };

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
  const iSit = (): boolean => state.self !== null && ((state.room?.seats.includes(state.self) ?? false) || state.room?.members.some((m) => m.id === state.self && m.floorSit === true) === true);
  const picker = createEmotePicker({
    bucket: emoteBucket,
    seated: iSit,
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
    // The wheel takes the room: the tour's chip goes (`firstHint` is made below; a wheel only opens once the room is up).
    onOpen: () => {
      if (layout.portraitOn() && document.activeElement === chatInput) chatInput.blur();
      firstHint.dismiss();
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
  // @-completion (OME-1531): the members here but me.
  const mentionList = attachMentionComplete(chatInput, (q) => mentionOptions(state.room?.members ?? [], state.self, q));
  /** /thrust and /bendover exist only where the room's layout says so (OME-1672). */
  const pairsOn = (): boolean => state.room?.layout?.pairs === true;
  // The command palette (OME-1586): every command and move, beside the emote key.
  const palette = createCommandPalette({ input: chatInput, form: chatForm, pairs: pairsOn });
  chatForm.append(picker.root, palette.field, chatSend, popOut, mentionList);
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
  // Room sounds (OME-1638): in Help's settings and, where people look for it, as a key beside Leave (OME-1968).
  const soundSetting = (): SoundSetting | null =>
    sound === null
      ? null
      : {
          volume: () => sound?.volume() ?? 0,
          setVolume: (v) => {
            sound?.setVolume(v);
            sound?.play("ui.tick");
            soundKey.sync();
          },
          muted: () => sound?.muted() ?? false,
          setMuted: (m) => {
            sound?.setMuted(m);
            sound?.play("ui.toggle");
            soundKey.sync();
          },
        };
  // The key goes with the stage, like Leave: not over the kicked or closed screens.
  let onStage = false;
  const soundKey = createSoundKey(() => (onStage ? soundSetting() : null));
  const help = createHelp({
    owner: () => state.owner && opts.secret?.ownerToken !== undefined,
    cinema,
    sound: soundSetting,
    tips: () => {
      firstHint.restart();
    },
  });
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
    walkOver,
    follow: (id) => {
      quitConga();
      follow(id);
    },
    hidden,
    sit: () => {
      floorSit();
    },
    onChange: (id, on) => {
      roomStage.hide(id, on);
      chatLog.hideFrom(isHidden);
      relay?.hideFrom(isHidden);
      // Their off never comes now (dropped at intake): the room window drops their dots as the page did.
      if (on) relay?.typing(id, false);
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
  // Shirt tint (OME-1352), atop the People panel: my avatar's ramps from tints.json, the pick saved for the next visit.
  // Hair colour (OME-1438) and the accessory (OME-1391) sit beside it: one line on a wide room, so the panel doesn't take height from the stage.
  const look = document.createElement("div");
  look.className = "look";
  people.panel.prepend(look);
  const tintSection = createTintSection({
    tints: parseTints(tintsJson, AVATAR_IDS)[opts.avatar]?.tints ?? [],
    tint: opts.tint,
    send: (m) => send(m),
    onPick: (t) => {
      saveTint(opts.secrets, t);
    },
  });
  const hairSection = createHairSection({
    hairs: AVATAR_HAIRS[opts.avatar]?.hairs ?? [],
    hair: opts.hair,
    send: (m) => send(m),
    onPick: (h) => {
      saveHair(opts.secrets, h);
    },
  });
  const accessorySection = createAccessorySection({
    accessory: opts.accessory,
    send: (m) => send(m),
    onPick: (a) => {
      saveAccessory(opts.secrets, a);
    },
  });
  look.append(tintSection, hairSection, accessorySection);
  // Outfit slots (OME-1453): what the rows show is what I wear; Wear picks in them, so only a change is sent (and saved).
  const radios = (section: HTMLElement): HTMLButtonElement[] => [...section.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  const checked = (section: HTMLElement): number => Math.max(0, radios(section).findIndex((b) => b.getAttribute("aria-checked") === "true"));
  look.append(createOutfitSlots({
    store: opts.secrets,
    current: () => {
      const me = state.room?.members.find((m) => m.id === state.self);
      return me === undefined ? null : { avatar: me.avatar, tint: checked(tintSection), hair: checked(hairSection), accessory: checked(accessorySection) };
    },
    wear: (fit) => {
      radios(tintSection)[fit.tint]?.click();
      radios(hairSection)[fit.hair]?.click();
      radios(accessorySection)[fit.accessory]?.click();
    },
  }));

  // The camera key (OME-1565): a polaroid of the room as it is now, saved locally (snap.ts). /snap does the same.
  const snapKey = el("button", { type: "button", className: "ui-button secondary snap-key", textContent: "Photo", title: "Save a photo of the room", hidden: true }, "snap-key");
  const snap = (): boolean => {
    snapRoom(roomStage.view.canvas, state.title ?? "omega-share", new Date());
    return true;
  };
  snapKey.addEventListener("click", snap);
  // Leave (OME-1967): top-left of the room bar, the same explicit leave as the report dialog's.
  const leaveKey = el("button", { type: "button", className: "ui-button secondary leave-key", textContent: "Leave", title: "Leave the room", hidden: true }, "leave-key");
  leaveKey.addEventListener("click", leaveForGood);
  roomTop.append(leaveKey, soundKey.root, title, popRoomKey, snapKey, people.key, help.key);
  // The first-visit tour (OME-1587): fixed chips beside the floor, the message field and People.
  const firstHint = createHints({
    // The `localStorage` getter itself throws when storage is blocked.
    storage: {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => {
        localStorage.setItem(k, v);
      },
    },
    // The floor chip sits on an empty TV just above its player bar, next to the floor without covering it; with a video
    // there it goes under the picture instead (hints.ts, OME-1778).
    anchor: (step) => (step === 0 ? controls : step === 1 ? chatForm : people.key),
    tv: { box: tv, empty: tvBox.empty, picture: wrap },
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

  // The open poll's card (OME-1454), pinned above the log wherever the layout puts it. Votes and closes go out on the socket;
  // my vote is marked once it went out (the server never says which option is mine).
  const castVote = (pollId: string, option: number): void => {
    if (state.poll?.pollId === pollId && state.vote !== option && send({ type: "vote", pollId, option })) dispatch({ type: "voted", pollId, option });
  };
  const closePoll = (pollId: string): void => {
    if (state.poll?.pollId === pollId) send({ type: "poll-close", pollId });
  };
  const pollCard = createPollCard({
    now: Date.now,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearTimer: (h) => {
      clearInterval(h);
    },
    vote: (option) => {
      if (state.poll !== null) castVote(state.poll.pollId, option);
    },
    close: () => {
      if (state.poll !== null) closePoll(state.poll.pollId);
    },
  });
  /** What the card shows for this state: the poll while I'm in; `endsAt` is server time, so the clock's offset brings it to mine. */
  const pollView = (s: ViewState): PollView | null =>
    s.poll === null || s.status !== "open"
      ? null
      : { pollId: s.poll.pollId, question: s.poll.question, options: s.poll.options, counts: s.poll.counts, vote: s.vote, canClose: s.poll.by === s.self || s.owner, endsAt: s.poll.endsAt - clock.offsetMs };

  // "Up next" (ADR 0031): the room's queue under the TV. Its rows are text; it redraws only when the queue changes.
  const queuePanel = createQueuePanel({ send, ownHosts: [location.hostname] });

  // The provider hint sits right above the TV, next to what it's about (OME-251): below the stage it's off-screen.
  // The owner's "Edit room" key (set (h)): made only for the owner, and the editor chunk loads only when it's pressed.
  const editBar = el("div", { className: "edit-bar" });
  const editorPanel = el("div", { className: "editor-panel" });
  // Set (k) phone watch layout (OME-596): TV full width, the room at 1× in a window you drag, chat right under it, no editor.
  const phone = globalThis.matchMedia(PHONE_QUERY);
  const portrait = globalThis.matchMedia(PORTRAIT_QUERY);
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
  opts.root.replaceChildren(roomTop, firstHint.root, people.panel, people.status, status, tvBox.hint, wrap, reactionBar.root, recap.root, roomAway, editBar, editorPanel, tvBox.personal, queuePanel.root, tvBox.notice, notice, pollCard.root, chatLog.root, chatForm, invite, ...cards.cards, side, cards.foot, help.dialog);
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
    bubbleSides: (x0, x1) => {
      roomStage.bubbleSides(x0, x1);
    },
    tv: tvBox,
    moments: strip.root,
    log: chatLog,
    poll: pollCard.root,
    composer: { form: chatForm, away: chatAway, popOut, picker },
    queue: queuePanel,
    notice,
    roomAway,
    roomTop,
    people: people.panel,
    invite,
    side,
    ownerBar: editBar,
    editorPanel,
    // The footer joins the Room sheet on a phone or tablet held upright (OME-1846); room.css hides it under the dock.
    settings: [editBar, tvBox.personal, invite, cards.foot, ...document.querySelectorAll<HTMLElement>("body > .site-footer")],
    foot: cards.foot,
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

  // The shared 3-2-1 (OME-1634): over the room, from each playback; the lights go down on 1.
  const countdown = createCountdown({
    serverNow: () => clock.serverNow(),
    plain: () => reducedMotion.matches || roomStage.root.querySelector("canvas")?.dataset["motion"] === "basic",
    onChange: () => {
      dim();
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h);
    },
  });
  roomStage.root.append(countdown.el);

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
    dim();
  }

  /** The room dims while the video plays, lifted while the editor is open (OME-1406); the mood shown is the drawn layout's (OME-1502). */
  let lightsDown = false;
  const dim = (): void => {
    const playing = pbView?.hasVideo === true && pbView.playing && countdown.lit();
    cinema.update(playing, owner.editing());
    const mood = (owner.preview() ?? layoutOf(state.room)).mood ?? "none";
    cinema.mood(mood);
    view.ambience(mood);
    sound?.tone(mood);
    // The lights-down swell (OME-1638) as the dim comes on.
    const down = cinema.on() && playing && !owner.editing();
    if (down && !lightsDown) sound?.play("swell");
    lightsDown = down;
  };

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
    walkOver,
    follow,
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
    if (!roomOut()) roomStage.render(s, owner.preview() ?? layoutOf(s.room), pbView?.catching === true, owner.editing());
    updateDoorChip(s.room, s.self, layoutOf(s.room));
    dim();
    const mySeat = s.self === null ? -1 : (s.room?.seats.indexOf(s.self) ?? -1);
    if (mySeat !== centredSeat) {
      centredSeat = mySeat;
      const p = roomStage.seat(mySeat);
      if (p !== undefined) layout.centre(p);
    }
    // Standing (who just joined, OME-1930), the touch window keeps me in view; seated, it looked at my seat above.
    layout.me(s.self === null || mySeat !== -1 ? null : (roomStage.spot(s.self) ?? null));
    if (title.textContent !== (s.title ?? "")) title.textContent = s.title ?? "";
    title.hidden = s.title === null;
    owner.render(s);
    status.textContent = STATUS_TEXT[s.status];
    const shown = screen(s);
    wrap.hidden = !shown.stage;
    reactionBar.root.hidden = !shown.stage || s.status !== "open" || s.room?.embed == null;
    help.key.hidden = !shown.stage;
    people.key.hidden = !shown.stage;
    snapKey.hidden = !shown.stage;
    leaveKey.hidden = !shown.stage;
    onStage = shown.stage;
    soundKey.sync();
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
        sound?.play("ui.error");
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
  // One of them named me (OME-1531): the title says (@) instead of the count.
  let mentioned = false;
  const writeTitle = (s: ViewState): void => {
    const t = screen(s).notFound ? NOT_FOUND_TITLE : roomPageTitle(s.title, unread, mentioned);
    if (document.title !== t) document.title = t;
  };
  const dispatch = (e: ViewEvent): void => {
    // A reaction (OME-1631) bursts over the sender; never view state. Hidden members' too stay hidden (OME-769).
    if (e.type === "server" && e.msg.type === "reacted" && !isHidden(e.msg.memberId)) {
      relay?.react(e.msg.memberId, e.msg.kind);
      if (!roomOut()) roomStage.react(e.msg.memberId, e.msg.kind);
    }
    if (e.type === "server" && e.msg.type === "walked" && e.msg.teleport === true) roomStage.teleported(e.msg.memberId);
    // Never view state (state.ts): straight to the moments.
    if (e.type === "server" && e.msg.type === "reacted") {
      const r: Reaction = { memberId: e.msg.memberId, kind: e.msg.kind, mediaMs: e.msg.mediaMs };
      reactions.push(r);
      if (reactions.length > REACTIONS_MAX) reactions.shift();
      replay.push(r);
      drawMoments();
    }
    const next = reduce(state, e);
    if (next === state) return;
    const unreadBefore = unread;
    // Who said it, so "Hide for me" can take a line down later (OME-769).
    const from = e.type === "server" && (e.msg.type === "chat" || e.msg.type === "rolled") ? e.msg.memberId : undefined;
    for (const entry of logEntries(state, next, e)) {
      chatLog.append(entry, from);
      if (entry.kind === "chat" && from !== undefined) popSticker(from, entry.text);
      // A max roll cheers (OME-1426); the server's chat bucket already paces rolls, so no sticker gate.
      const cheer = e.type === "server" && e.msg.type === "rolled" ? rollSticker(e.msg.sides, e.msg.value) : null;
      if (cheer !== null && from !== undefined) emoted(from, cheer);
      // Popped out: the window gets the line now, not on the next frame (a hidden tab draws none).
      relay?.append(entry, from);
      // Collapsed in full screen: count what others said while the lines are out of sight.
      if (entry.kind === "chat" && !entry.self) {
        // Chat hidden in full screen (OME-1491): the line shows beside the picture, unless I hid its speaker.
        const speaker = from === undefined || isHidden(from) ? undefined : next.room?.members.find((m) => m.id === from);
        if (speaker !== undefined) layout.fsChat.say(speaker.avatar, entry.nickname, entry.text);
        layout.missed();
        if (document.visibilityState === "hidden") {
          unread++;
          if (entry.mention === true) mentioned = true;
        }
      }
    }
    const expiriesChanged = next.bubbles !== state.bubbles || next.syslines !== state.syslines || next.cooldownUntil !== state.cooldownUntil;
    const prevState = state;
    const prevRoom = state.room;
    const prevOwner = state.owner;
    if (unread !== unreadBefore || next.title !== state.title || next.status !== state.status) writeTitle(next);
    // Keeps Your rooms' label current for a room this browser saved (OME-1284).
    if (next.title !== null && next.title !== state.title) retitleRoom(opts.secrets, opts.roomId, next.title);
    state = next;
    // Follow (OME-1389): their walk sends mine (through the walk gate); them or me sitting, or them leaving, stops it.
    if (following !== null) {
      const step = followStep(prevState, next, following);
      if (step === "stop") stopFollow();
      else if (step === "walk") walkOver(following)?.();
    }
    const line = congaStep(conga, e.type === "server" ? e.msg : null, prevState, next);
    if (line !== conga) {
      conga = line;
      people.conga(line.ids);
      roomStage.view.conga(line.ids);
    }
    congaFollow();
    if (hug !== null) {
      const step = hugStep(prevState, next, hug);
      if (step === "cancel") hug = null;
      // The room's window draws no walk while it's popped out: there's no stop to wait for.
      else if (step === "arrived" && roomOut()) hugNow();
      else if (step === "arrived") hug.arrived = true;
    }
    applyPending({ owner: next.owner && opts.secret?.ownerToken !== undefined, hasRoom: next.room !== null });
    // Moments (OME-1628): a snapshot brings the item's reactions and catches me up; a new item starts empty.
    if (e.type === "server" && e.msg.type === "snapshot") {
      reactions = [...(e.msg.reactions ?? [])];
      replay.start(reactions);
      drawMoments();
    } else if (next.room?.itemId !== prevRoom?.itemId) {
      showRecap(prevRoom?.itemId);
      watched.clear();
      see(next.room?.members);
      reactions = [];
      replay.stop();
      drawMoments();
    }
    if (next.room?.members !== prevRoom?.members) see(next.room?.members);
    // Straight to the sync loop, not via the next frame: a new playback is a hard seek.
    const room = next.room;
    if (room?.embed !== prevRoom?.embed || room?.playback !== prevRoom?.playback) {
      playback.setRoom(room === null ? { embed: null, playback: null } : { embed: room.embed, playback: room.playback ?? null, itemId: room.itemId });
      countdown.set(room?.playback ?? null);
      tvBox.sync(next);
      replay.sync();
    }
    if (next.owner !== prevOwner || next.room?.controlPolicy !== prevRoom?.controlPolicy) playback.setControl({ policy: controlPolicy(next), held: controlHeld(next) });
    if (expiriesChanged) scheduleExpiry();
    // Always, so a window adopted later starts from the room as it is (only posted while popped out, and if changed).
    relay?.update(popState(next));
    relay?.view(next);
    if (next.poll !== prevState.poll || next.vote !== prevState.vote || next.status !== prevState.status || next.owner !== prevOwner) {
      const poll = pollView(next);
      if (poll === null) pollCard.hide();
      else pollCard.show(poll);
      relay?.poll(poll);
    }
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
  const localResume: ResumeStore = {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, value) => {
      localStorage.setItem(k, value);
    },
    removeItem: (k) => {
      localStorage.removeItem(k);
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
  // Chat stickers (OME-1349): read from the relayed line by every viewer, nothing on the wire; one per member per 3 s,
  // none under reduced motion.
  const stickers = createStickerGate();
  const popSticker = (id: MemberId, text: string): void => {
    const kind = reducedMotion.matches ? null : chatSticker(text);
    if (kind !== null && stickers.allow(id, performance.now())) emoted(id, kind);
  };
  /** A slash command (OME-1349), from the box or the pop-out: true/false = ran (sent or not), null = not one, it's chat. */
  const runSlash = (text: string): boolean | null => {
    const cmd = slashCommand(text, pairsOn());
    if (cmd === null || cmd.type === "line") {
      // /conga and /stop go out as chat lines; past the cap, or /stop out of the line, they stay here.
      const c = congaText(text);
      if (c === "conga" && state.self !== null && congaJoin(conga, state.self, clock.serverNow()) === "full") hint(CONGA_FULL_LINE);
      else if (c === "stop" && (state.self === null || !conga.ids.includes(state.self))) stopFollow();
      else return null;
      return true;
    }
    if (cmd.type === "emote" && !(cmd.kind === "dance" && iSit())) return picker.emote(cmd.kind);
    if (cmd.type === "roll") return send({ type: "roll", sides: cmd.sides });
    if (cmd.type === "poll") return send({ type: "poll-open", question: cmd.question, options: [...cmd.options] });
    if (cmd.type === "hug") return startHug(cmd.kind, cmd.name);
    if (cmd.type === "pair") return send({ type: "pair", pose: cmd.pose });
    if (cmd.type === "pet") return startPet();
    if (cmd.type === "sit") return floorSit();
    if (cmd.type === "snap") return snap();
    hint(cmd.type === "help" ? helpLine(pairsOn()) : cmd.type === "roll-usage" ? ROLL_USAGE_LINE : cmd.type === "hug-usage" ? HUG_USAGE_LINE : cmd.type === "poll-usage" ? POLL_USAGE_LINE : DANCE_SEATED_LINE);
    return true;
  };
  /** A line to me only, here and in the pop-out. */
  function hint(line: SystemLine): void {
    chatLog.append({ kind: "system", line });
    relay?.append({ kind: "system", line });
  }
  /** /hug and /highfive (OME-1453): walk over to them; the emote waits for the arrival (or goes now if I'm beside them). */
  function startHug(kind: EmoteKind, name: string): boolean {
    const room = state.room;
    if (room === null || state.self === null) return false;
    const m = matchMember(room.members, state.self, name);
    if (m.type !== "match") {
      hint(hugHint(m.type === "none" ? `Nobody here is called ${name}` : `More than one person here is called ${name}`));
      return true;
    }
    hug = null;
    const msg = walkOverIntent(state, m.id, (id) => roomStage.cellOf(id));
    if (msg?.type === "walk") {
      quitConga();
      stopFollow();
      walkGate.push(msg);
      hug = { target: m.id, cell: msg.cell, kind, arrived: false };
      return true;
    }
    const where = (id: MemberId): FloorCell | null => room.members.find((x) => x.id === id)?.cell ?? roomStage.cellOf(id);
    const here = where(state.self);
    const there = where(m.id);
    if (here !== null && there !== null && Math.abs(here.x - there.x) + Math.abs(here.y - there.y) === 1) return picker.emote(kind);
    hint(hugHint(`No free spot beside ${m.nickname}`));
    return true;
  }
  /** /pet or a tap on the cat (OME-1669): walk beside the nearest cat, then the heart (at once if I'm beside one). Zero wire. */
  function startPet(tries = 0): boolean {
    const room = state.room;
    const self = state.self;
    const me = self === null ? null : (room?.members.find((m) => m.id === self)?.cell ?? roomStage.cellOf(self));
    if (room === null || state.status !== "open" || me === null) return false;
    const cats = roomStage.catCells();
    if (cats.length === 0) {
      hint(hugHint("There's no cat here"));
      return true;
    }
    hug = null;
    const here = cellIndex(me.x, me.y);
    if (isPetting(here, cats)) return picker.emote("heart");
    const taken = new Set<number>();
    for (const m of room.members) if (m.cell !== undefined && m.id !== self) taken.add(cellIndex(m.cell.x, m.cell.y));
    const spot = petSpot(walkGrid(room.layout ?? DEFAULT_LAYOUT), cats, here, taken);
    if (spot === null) {
      hint(hugHint("No free spot beside the cat"));
      return true;
    }
    quitConga();
    stopFollow();
    const cell = { x: colOf(spot), y: rowOf(spot) };
    walkGate.push({ type: "walk", cell });
    hug = { target: null, cell, kind: "heart", arrived: false, tries };
    return true;
  }
  // Crowd applause (OME-1389): from the relayed emotes only (a chat sticker isn't one), so every client agrees.
  const applause = createApplause();
  const relayedEmote = (id: MemberId, kind: EmoteKind): void => {
    // A heart from beside a cat is a pet (OME-1669): the avatar reaches out (OME-1697), the cat gets the heart. Reduced motion: the plain badge.
    const at = kind === "heart" && !reducedMotion.matches ? roomStage.cellOf(id) : null;
    const cats = at === null ? [] : roomStage.catCells();
    const cat = at === null ? undefined : cats.find((c) => isPetting(cellIndex(at.x, at.y), [c]));
    if (cat === undefined) emoted(id, kind);
    else {
      // shortcut: the pop-out channel carries EmoteKind only, so a popped-out room still sees a wave; widen the channel if that matters.
      relay?.emote(id, "wave");
      if (!roomOut()) roomStage.emote(id, "reach", state);
      roomStage.petCat(cat);
    }
    if (applause.push(id, kind, performance.now()) && !roomOut()) view.confetti();
  };
  const kickedStore = sessionStorage;
  const sinks: RoomEventSinks = { clock, shareToken, joined: () => { playback.joined(); roomStage.stopTyping(); relay?.stopTyping(); }, kicked: (wasIn) => (wasIn ? rememberKick : bouncedUntil)(kickedStore, opts.roomId, Date.now()), dispatch, emoted: relayedEmote, pair: (msg) => {
    if (msg.type === "paired") {
      if (!roomOut()) roomStage.pair(msg.thrust, msg.bendover);
      return;
    }
    hint(pairInvitedLine(state.room?.members.find((m) => m.id === msg.memberId)?.nickname ?? "Someone", msg.memberId === state.self, msg.pose));
  }, typing: (id, on) => {
    // My own box shows I'm typing.
    if (id === state.self) return;
    roomStage.typing(id, on);
    relay?.typing(id, on);
  }, hidden: isHidden, session: (token) => {
    sentAway = false;
    saveResume(resumeStore, { roomId: opts.roomId, token, nickname: opts.nickname, avatar: opts.avatar });
    // The server cleared away on this (re)join; a tab that came back while still hidden says so again.
    sendPresence(true);
  } };
  // Kicked from this room in this tab and the cooldown isn't over (ADR 0030 §2): show the notice, don't even try to join.
  const kickedTill = kickedUntil(kickedStore, opts.roomId, Date.now());
  const c: Connection = kickedTill !== null ? stoppedConnection() : createConnection({
    url: opts.socketUrl,
    join: joinMessage(opts.nickname, opts.avatar, opts.secret, opts.tint, opts.accessory, opts.hair, takeVia(viaStore, opts.roomId)),
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
          command: runSlash,
          onVote: castVote,
          onPollClose: closePoll,
          openWindow: (kind) => {
            if (kind === "room") window.open(roomPopoutUrl(opts.roomId, tab), "_blank", "noopener,popup,width=1280,height=668");
            else window.open(popoutUrl(opts.roomId, tab), "_blank", "noopener,popup,width=380,height=640");
          },
          onPopped,
          onSeat: (seat) => {
            const msg = sitIntent(state, seat);
            if (msg === null) return;
            walkGate.cancel();
            c.send(msg);
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
    const lie = ev.target.closest<HTMLElement>("[data-lie]")?.dataset["lie"];
    const seat = Number(ev.target.closest<HTMLElement>("[data-seat]")?.dataset["seat"] ?? NaN);
    const msg = lie === undefined ? sitIntent(state, seat) : lieIntent(state, Number(lie));
    if (msg === null) return;
    walkGate.cancel();
    c.send(msg);
  });
  // The typing indicator (OME-1390): what the box holds, as the room sees it.
  const typingSender = createTypingSender({ now: () => performance.now(), send: (on) => c.send({ type: "typing", on }) });
  chatInput.addEventListener("input", () => {
    typingSender.input(chatInput.value);
  });
  chatInput.addEventListener("blur", () => {
    typingSender.blur();
  });
  chatForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    // Held while the server says rate_limited; the text stays in the box for when it reopens.
    const ran = runSlash(chatInput.value);
    if (ran === null && chatView(state, Date.now()).cooling) return;
    const msg = ran === null ? chatIntent(chatInput.value) : null;
    if (ran === true || (msg !== null && c.send(msg))) {
      chatInput.value = "";
      // A line clears typing on the server; a slash command sends no line, so say it here.
      if (ran === true) typingSender.input("");
      else typingSender.sent();
      // Sent from the key without the field focused: the next line goes straight in.
      if (document.activeElement === chatSend) chatInput.focus({ preventScroll: true });
    }
  });
  // Keys 1–9 emote and Escape closes the picker, anywhere on the page but a text field, while we're in the room.
  window.addEventListener("keydown", (ev) => {
    // The report and help dialogs are modal: the room's keys wait until they close.
    if (cards.reportOpen() || help.isOpen()) return;
    if (layout.dock.sheet.open) {
      if (ev.target instanceof Node && picker.root.contains(ev.target) && picker.key(ev)) ev.preventDefault();
      return;
    }
    // Esc ends the first-visit tour and still does whatever else it does here.
    if (ev.key === "Escape") firstHint.dismiss();
    // Tab peeks full screen's hidden chat (OME-1668), so it can take the focus; focus elsewhere lets it go again.
    if (ev.key === "Tab") {
      layout.fsChat.peek(true);
      layout.fsChat.peek(false);
    }
    if (owner.key(ev)) ev.preventDefault();
    else if (!help.key.hidden && help.shortcut(ev)) ev.preventDefault();
    // Before the picker, shown or not: on some layouts Shift+digit types a digit, which the picker would take as an emote.
    else if (reactionBar.key(ev)) ev.preventDefault();
    else if (state.status === "open" && !chatForm.hidden && picker.key(ev)) ev.preventDefault();
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !wrap.hidden && (layout.fs.key(ev.key, typingIn(ev.target), ev.repeat) || layout.fsChat.key(ev.key, typingIn(ev.target), ev.repeat))) ev.preventDefault();
    else if (state.status === "open" && !chatForm.hidden) {
      // Enter with nothing that takes it focused jumps to the message field, here or in full screen; Esc hands back (OME-642).
      const k = chatKey(ev, chatInput);
      if (k === null) return;
      ev.preventDefault();
      if (k === "focus") {
        // Full screen's hidden chat comes back first (OME-1668): a hidden field takes no focus.
        layout.fsChat.peek(true);
        chatInput.focus();
      }
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
    // Closing the tab ends sessionStorage, not the server's hold: hand the session to the room's next tab (OME-2075).
    const kept = loadResume(resumeStore, opts.roomId);
    if (kept !== null) handOffResume(localResume, kept, Date.now());
    relay?.close();
    c.close();
    clock.stop();
    stopInvite();
  });
  window.addEventListener("pageshow", (ev) => {
    if (!ev.persisted) return;
    // Back from the bfcache: this tab keeps its session, so no other tab may take the hand-off.
    takeHandOff(localResume, opts.roomId, 0);
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
        mentioned = false;
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
  // Sound (OME-1638): unlocked by the Enter gesture that got us here (its activation still holds), and by the next
  // pointer or key press if the browser kept it suspended (a resumed session had no gesture).
  void import("./audio")
    .then(({ loadSound, floorKinds }) => {
      let floors: { layout: RoomLayout; at: (cell: number) => FloorKind } | null = null;
      sound = loadSound({
        store: {
          getItem: (k) => localStorage.getItem(k),
          setItem: (k, v) => {
            localStorage.setItem(k, v);
          },
        },
        listener: () => (state.self === null ? null : (view.position(state.self) ?? null)),
        floorAt: (p) => {
          const l = layoutOf(state.room);
          if (floors?.layout !== l) floors = { layout: l, at: floorKinds(l.furniture) };
          return floors.at(cellAt(p));
        },
      });
      sound.unlock();
      soundKey.sync();
      for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => sound?.unlock(), { capture: true, passive: true });
      dim();
    })
    .catch((e: unknown) => {
      console.warn("sound: not loaded", e);
    });
  return { state: () => state, send: (m) => c.send(m), playback: () => playback.view(), scene: () => view.drawOrder(), layoutBuilds: () => roomStage.layoutBuilds(), avatarFrames: (id) => view.frames(id), head: (id) => roomStage.head(id), queueRenders: () => queuePanel.renders(), roomPaused: () => view.paused(), roomRenders: () => view.renders(), avatarAlpha: (id) => view.alpha(id), theme: () => view.theme(), confetti: () => view.confettiBursts(), furnitureLoops: () => view.loops(), cats: () => view.cats() };
}
