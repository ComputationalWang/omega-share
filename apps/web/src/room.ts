// Room screen. Loaded lazily after Enter so PixiJS stays out of the initial bundle.
import "pixi.js/unsafe-eval";
import type { Avatar, ClientMessage, Embed, ErrorCode, MemberId, Nickname, RoomId } from "@omega/shared";
import { browserNow, createClockSync } from "./clock";
import { createConnection, type Connection, type SocketLike } from "./connection";
import { trackShareToken } from "./share-token";
import { createPersonal, createTransport, el, renderSyslines } from "./controls/dom";
import { createPlaybackController, type PlaybackView } from "./controls/playback";
import { mountErrorText, playerErrorText } from "./controls/player-error";
import { chatIntent, seatViews, sitIntent } from "./intents";
import { BUBBLE_OFFSET_Y, SEATS, STANDING, SYSLINE_RAIL, TAG_OFFSET_Y, roomLayout, type Point, type Rect } from "./layout";
import type { PlayerError } from "./player/adapter";
import { PLAYERS, createPlayerMounter } from "./player/registry";
import { createRoomView, type AvatarPlacement, type RoomView } from "./room-view";
import { initialState, nextExpiry, reduce, screen, type ViewEvent, type ViewState } from "./state";
import { tvFrame, type TvFrame } from "./tv";

export interface RoomOptions {
  readonly root: HTMLElement;
  readonly roomId: RoomId;
  readonly socketUrl: string;
  readonly nickname: Nickname;
  readonly avatar: Avatar;
}

export interface RoomHandle {
  readonly state: () => ViewState;
  readonly send: (msg: ClientMessage) => boolean;
  /** What the playback chrome shows (QA reads it in dev builds). */
  readonly playback: () => PlaybackView;
}

const STATUS_TEXT: Record<ViewState["status"], string> = {
  idle: "",
  connecting: "Connecting…",
  open: "",
  reconnecting: "Connection lost, reconnecting…",
  full: "",
};

const NOTICE_MS = 3000;
const ERROR_TEXT: Record<ErrorCode, string> = {
  seat_taken: "Someone just took that seat.",
  rate_limited: "Slow down a little.",
  bad_message: "That didn't go through.",
  not_joined: "Still joining, try again in a moment.",
  already_joined: "You're already in this room.",
  no_embed: "That video isn't playing here any more.",
  nickname_taken: "Someone in this room already has that name.",
  too_many_members: "Too many people from your network are in this room.",
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
  ws.onclose = () => s.onclose?.();
  ws.onerror = () => s.onerror?.();
  return s;
}

function place(e: HTMLElement, p: Point): void {
  e.style.transform = `translate(${String(p.x)}px, ${String(p.y)}px)`;
}

function box(e: HTMLElement, r: Rect): void {
  Object.assign(e.style, { left: `${String(r.x)}px`, top: `${String(r.y)}px`, width: `${String(r.w)}px`, height: `${String(r.h)}px` });
}

export async function startRoom(opts: RoomOptions): Promise<RoomHandle> {
  const status = el("p", { className: "status", role: "status" }, "connection-status");
  const notice = el("p", { className: "notice", role: "alert", hidden: true }, "room-notice");
  const full = el("div", { className: "room-full", hidden: true }, "room-full");
  full.append(el("h2", { textContent: "This room is full" }), el("p", { textContent: "Try again in a little while." }));

  // The TV and its control bar sit above the scaled stage, unscaled, so the player keeps
  // YouTube's minimum size and no room layer can stack over it (layout.ts `roomLayout`).
  // .ui-room: set (e)/(c) chrome inside the stage is at the room's 1× art scale.
  const stage = el("div", { className: "stage ui-room" }, "room");
  const clip = el("div", { className: "stage-clip" });
  clip.append(stage);
  const tv = el("div", { className: "tv ui-tv-frame" });
  const controls = el("div", { className: "controls ui-tv-shelf" });
  const wrap = el("div", { className: "stage-wrap", hidden: true });
  wrap.append(tv, controls, clip);
  const tvEmpty = el("p", { className: "tv-empty", textContent: "Share a video with the extension to watch it here." });
  tv.append(tvEmpty);
  const overlay = el("div", { className: "overlay" });
  const seatButtons = SEATS.map((p, i) => {
    const b = el("button", { type: "button", className: "seat" }, "seat");
    b.dataset["seat"] = String(i);
    place(b, p);
    return b;
  });
  overlay.append(...seatButtons);
  const tags = el("div", { className: "tags" });
  const bubbles = el("div", { className: "bubbles", ariaLive: "polite" });
  // Chat system lines ("Ana paused"): caption rail in the stage's bottom-left, text only.
  const rail = el("div", { className: "syslines", ariaLive: "polite" });
  box(rail, SYSLINE_RAIL);
  const syncNotice = el("p", { className: "notice sync-notice", role: "status", hidden: true }, "sync-notice");

  const chatForm = el("form", { className: "chat" });
  const chatInput = el("input", { type: "text", maxLength: 280, placeholder: "Say something…", autocomplete: "off", ariaLabel: "Chat message" }, "chat-input");
  chatForm.append(chatInput, el("button", { type: "submit", textContent: "Say" }));

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
  controls.append(transport.root);
  const personal = createPersonal(playback);

  const view: RoomView = await createRoomView();
  view.canvas.className = "scene";
  stage.append(view.canvas, overlay, tags, bubbles, rail);
  opts.root.replaceChildren(status, wrap, personal.root, syncNotice, notice, chatForm, full);

  /** The shown embed's provider: Twitch needs a larger TV (layout.ts). */
  let tvProvider: Embed["provider"] | null = null;
  const fit = (): void => {
    const l = roomLayout(wrap.clientWidth, tvProvider);
    box(tv, l.tv);
    box(controls, l.controls);
    tv.classList.toggle("compact", l.compact.tv);
    controls.classList.toggle("compact", l.compact.controls);
    box(clip, l.stage);
    stage.style.transform = `scale(${String(l.scale)})`;
    wrap.style.height = `${String(l.height)}px`;
  };
  new ResizeObserver(fit).observe(wrap);
  fit();

  let frame = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let tvKey: string | null = null;
  let drawnSeats: readonly unknown[] | undefined;
  let drawnMembers: readonly unknown[] | undefined;
  let catchTag: HTMLElement | null = null;
  const hourglass = el("span", { className: "ui-sprite ui-catchup", ariaHidden: "true" });
  const syslineEls = new Map<number, HTMLElement>();
  let shownError: ViewState["lastError"] = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  const tagEls = new Map<MemberId, HTMLElement>();
  const bubbleEls = new Map<MemberId, HTMLElement>();

  /** My own tag carries the hourglass while my player catches up (local only in M1b). */
  const applyCatching = (): void => {
    const self = state.self === null ? null : (tagEls.get(state.self) ?? null);
    const want = pbView?.catching === true ? self : null;
    if (want === catchTag) return;
    catchTag?.classList.remove("catching");
    hourglass.remove();
    catchTag = want;
    if (want !== null) {
      want.classList.add("catching");
      want.prepend(hourglass);
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

  const render = (): void => {
    frame = 0;
    const s = state;
    status.textContent = STATUS_TEXT[s.status];
    const shown = screen(s);
    wrap.hidden = !shown.stage;
    chatForm.hidden = !shown.chat;
    full.hidden = !shown.full;

    const placements: AvatarPlacement[] = [];
    const at = new Map<MemberId, Point>();
    const views = seatViews(s);
    for (const v of views) {
      const p = SEATS[v.index];
      if (v.member !== null && p !== undefined) {
        placements.push({ id: v.member.id, avatar: v.member.avatar, at: p });
        at.set(v.member.id, p);
      }
    }
    let k = 0;
    for (const m of s.room?.members ?? []) {
      if (at.has(m.id)) continue;
      const p = STANDING[k++];
      if (p === undefined) continue;
      placements.push({ id: m.id, avatar: m.avatar, at: p });
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
    }
    for (const m of members.values()) {
      let e = tagEls.get(m.id);
      if (e === undefined) {
        e = el("span", { className: "tag ui-tag" }, "nickname-tag");
        e.append(el("span", { className: "tag-name", textContent: m.nickname }));
        tagEls.set(m.id, e);
        tags.append(e);
      }
      e.classList.toggle("self", m.id === s.self);
      const p = at.get(m.id);
      if (p !== undefined) place(e, { x: p.x, y: p.y + TAG_OFFSET_Y });
    }

    const live = new Set(s.bubbles.map((b) => b.memberId));
    for (const [id, e] of bubbleEls) {
      if (live.has(id)) continue;
      e.remove();
      bubbleEls.delete(id);
    }
    for (const b of s.bubbles) {
      const p = at.get(b.memberId);
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

  };

  /**
   * Swap the TV iframe with the embed. Runs from dispatch, not the next frame: rAF doesn't fire in a
   * background tab, and the old video must not keep playing (unsynced) after the controller dropped it.
   */
  const syncTv = (s: ViewState): void => {
    const embed = s.room?.embed ?? null;
    const tf = tvFrame(embed);
    const nextKey = tf?.key ?? null;
    if (nextKey !== tvKey) {
      tvKey = nextKey;
      const provider = tf === null ? null : (embed?.provider ?? null);
      if (provider !== tvProvider) {
        tvProvider = provider;
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

  const scheduleExpiry = (): void => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    const at = nextExpiry(state);
    if (at === null) return;
    expiryTimer = setTimeout(() => {
      dispatch({ type: "tick", now: Date.now() });
    }, Math.max(0, at - Date.now()));
  };

  const dispatch = (e: ViewEvent): void => {
    const next = reduce(state, e);
    if (next === state) return;
    const expiriesChanged = next.bubbles !== state.bubbles || next.syslines !== state.syslines;
    const prevRoom = state.room;
    state = next;
    // Straight to the sync loop, not via the next frame: a new playback is a hard seek.
    const room = next.room;
    if (room?.embed !== prevRoom?.embed || room?.playback !== prevRoom?.playback) {
      playback.setRoom(room ?? { embed: null, playback: null });
      syncTv(next);
    }
    if (expiriesChanged) scheduleExpiry();
    if (frame === 0) frame = requestAnimationFrame(render);
  };

  const shareToken = trackShareToken(sessionStorage, opts.roomId);
  const c: Connection = createConnection({
    url: opts.socketUrl,
    join: { type: "join", nickname: opts.nickname, avatar: opts.avatar },
    createSocket: browserSocket,
    onOpen: () => {
      clock.start();
    },
    onEvent: (e) => {
      shareToken.onEvent(e);
      if (e.type === "message") {
        if (e.msg.type === "pong") clock.onPong(e.msg.id, e.msg.at);
        else dispatch({ type: "server", msg: e.msg, now: Date.now() });
      } else {
        if (e.type === "disconnected") clock.stop();
        dispatch(e);
      }
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h);
    },
  });

  conn = c;
  playback.start();

  overlay.addEventListener("click", (ev) => {
    if (!(ev.target instanceof HTMLElement)) return;
    const seat = Number(ev.target.closest<HTMLElement>("[data-seat]")?.dataset["seat"] ?? NaN);
    const msg = sitIntent(state, seat);
    if (msg !== null) c.send(msg);
  });
  chatForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const msg = chatIntent(chatInput.value);
    if (msg !== null && c.send(msg)) chatInput.value = "";
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

  syncTv(state);
  render();
  pbView = playback.view();
  renderControls();
  return { state: () => state, send: (m) => c.send(m), playback: () => playback.view() };
}
