// Room screen. Loaded lazily after Enter so PixiJS stays out of the initial bundle.
import "pixi.js/unsafe-eval";
import type { Avatar, ClientMessage, ErrorCode, MemberId, Nickname, RoomId } from "@omega/shared";
import { createConnection, type Connection, type SocketLike } from "./connection";
import { chatIntent, seatViews, sitIntent } from "./intents";
import { SEATS, STAGE_H, STAGE_W, STANDING, TV, type Point } from "./layout";
import { createRoomView, type AvatarPlacement, type RoomView } from "./room-view";
import { initialState, nextExpiry, reduce, screen, type ViewEvent, type ViewState } from "./state";
import { tvFrame } from "./tv";

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
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, testId?: string): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  if (testId !== undefined) e.setAttribute("data-testid", testId);
  return e;
}

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

export async function startRoom(opts: RoomOptions): Promise<RoomHandle> {
  const status = el("p", { className: "status", role: "status" }, "connection-status");
  const notice = el("p", { className: "notice", role: "alert", hidden: true }, "room-notice");
  const full = el("div", { className: "room-full", hidden: true }, "room-full");
  full.append(el("h2", { textContent: "This room is full" }), el("p", { textContent: "Try again in a little while." }));

  const stage = el("div", { className: "stage" }, "room");
  const wrap = el("div", { className: "stage-wrap", hidden: true });
  wrap.append(stage);
  const tv = el("div", { className: "tv" });
  Object.assign(tv.style, { left: `${String(TV.x)}px`, top: `${String(TV.y)}px`, width: `${String(TV.w)}px`, height: `${String(TV.h)}px` });
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

  const chatForm = el("form", { className: "chat" });
  const chatInput = el("input", { type: "text", maxLength: 280, placeholder: "Say something…", autocomplete: "off", ariaLabel: "Chat message" }, "chat-input");
  chatForm.append(chatInput, el("button", { type: "submit", textContent: "Say" }));

  const view: RoomView = await createRoomView();
  view.canvas.className = "scene";
  stage.append(view.canvas, tv, overlay, tags, bubbles);
  opts.root.replaceChildren(status, wrap, notice, chatForm, full);

  const fit = (): void => {
    const scale = Math.min(1, wrap.clientWidth / STAGE_W);
    stage.style.transform = `scale(${String(scale)})`;
    wrap.style.height = `${String(STAGE_H * scale)}px`;
  };
  new ResizeObserver(fit).observe(wrap);
  fit();

  let state = initialState;
  let frame = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let tvSrc: string | null = null;
  let drawnRoom: ViewState["room"] | undefined;
  let shownError: ViewState["lastError"] = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  const tagEls = new Map<MemberId, HTMLElement>();
  const bubbleEls = new Map<MemberId, HTMLElement>();

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
    // Chat and bubbles leave `room` untouched, so the scene is only redrawn when seats, members or embed change.
    if (s.room !== drawnRoom) {
      drawnRoom = s.room;
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
        e = el("span", { className: "tag", textContent: m.nickname }, "nickname-tag");
        tagEls.set(m.id, e);
        tags.append(e);
      }
      e.classList.toggle("self", m.id === s.self);
      const p = at.get(m.id);
      if (p !== undefined) place(e, { x: p.x, y: p.y + 10 });
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
      if (p !== undefined) place(e, { x: p.x, y: p.y - 48 });
    }

    const tf = tvFrame(s.room?.embed ?? null);
    const nextSrc = tf?.src ?? null;
    if (nextSrc !== tvSrc) {
      tvSrc = nextSrc;
      if (tf === null) tv.replaceChildren(tvEmpty);
      else {
        const iframe = el("iframe", { src: tf.src, allow: tf.allow, referrerPolicy: tf.referrerPolicy, title: "Shared video" }, "shared-video");
        iframe.setAttribute("sandbox", tf.sandbox);
        tv.replaceChildren(iframe);
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
    const bubblesChanged = next.bubbles !== state.bubbles;
    state = next;
    if (bubblesChanged) scheduleExpiry();
    if (frame === 0) frame = requestAnimationFrame(render);
  };

  const conn: Connection = createConnection({
    url: opts.socketUrl,
    join: { type: "join", nickname: opts.nickname, avatar: opts.avatar },
    createSocket: browserSocket,
    onEvent: (e) => {
      dispatch(e.type === "message" ? { type: "server", msg: e.msg, now: Date.now() } : e);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h);
    },
  });

  overlay.addEventListener("click", (ev) => {
    if (!(ev.target instanceof HTMLElement)) return;
    const seat = Number(ev.target.closest<HTMLElement>("[data-seat]")?.dataset["seat"] ?? NaN);
    const msg = sitIntent(state, seat);
    if (msg !== null) conn.send(msg);
  });
  chatForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const msg = chatIntent(chatInput.value);
    if (msg !== null && conn.send(msg)) chatInput.value = "";
  });
  // Close on unload so the server frees the seat now; a bfcache restore reconnects.
  window.addEventListener("pagehide", () => {
    conn.close();
  });
  window.addEventListener("pageshow", (ev) => {
    if (ev.persisted) conn.resume();
  });

  render();
  return { state: () => state, send: (m) => conn.send(m) };
}
