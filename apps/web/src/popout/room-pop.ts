// The whole-room pop-out window (OME-600, M7 W3b, set k `ui-m7-popout`, ADR 0035): `room.html`, opened by the room tab
// with noopener. It draws the room (the one renderer: the room tab pauses its own while the room is here) from the stage
// state the room tab mirrors over the channel, with the chat column (popout/view.ts) beside it and a brass plate saying
// where the picture is and its time. No socket, no join, no provider SDK: seat clicks, chat and emotes go back to the
// room tab, which sends them on its one WebSocket.
import type { EmoteKind, MemberId, RoomId } from "@omega/shared";
import { el } from "../controls/dom";
import { formatClock } from "../controls/sysline";
import { popRoomLayout } from "../layout";
import type { StageState } from "../state";
import { stageOf, type PopChannel, type PopTv, type RoomSideMessage } from "./channel";
import { createPopoutView } from "./view";

/** What the window needs of the stage (stage.ts `Stage`; tests pass a stand-in). */
export interface PopStage {
  /** Holds the `[data-seat]` keys. */
  readonly root: HTMLElement;
  render(s: StageState, selfCatching: boolean): void;
  emote(id: MemberId, kind: EmoteKind): void;
}

export interface RoomPopoutOptions<H> {
  readonly root: HTMLElement;
  readonly document: Document;
  readonly pop: string;
  readonly roomId: RoomId;
  readonly channel: PopChannel;
  readonly stage: PopStage;
  /** The window's inner size, CSS px. */
  readonly size: () => { readonly w: number; readonly h: number };
  readonly requestFrame: (cb: FrameRequestCallback) => unknown;
  /** "Show the window" in the page: come to the front. */
  readonly focusWindow: () => void;
  readonly closeWindow: () => void;
  readonly navigate: (url: string) => void;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => H;
  readonly clearTimer: (h: H) => void;
  readonly setInterval: (fn: () => void, ms: number) => H;
}

export interface RoomPopout {
  /** A keydown on the window: keys 1–6 emote, Escape closes the picker. True if it was ours. */
  key(ev: KeyboardEvent): boolean;
  /** The window is closing (pagehide). */
  bye(): void;
  /** Lay the room and the chat out for the window's size now. */
  fit(): void;
}

/** The plate's words: where the picture is and the room's time (set k: "Playing on your main screen · 25:31"). */
function plateText(t: PopTv): string {
  if (t.live) return "Live on your main screen";
  return `${t.playing ? "Playing" : "Paused"} on your main screen · ${formatClock(t.position)}`;
}

export function createRoomPopout<H>(o: RoomPopoutOptions<H>): RoomPopout {
  const frame = el("div", { className: "poproom" });
  const side = el("div", { className: "ui-pop poproom-room" }, "poproom-room");
  const plate = el("p", { className: "ui-chip self poproom-plate", hidden: true }, "poproom-plate");
  const clip = el("div", { className: "poproom-clip" });
  clip.append(o.stage.root);
  side.append(clip, plate);
  const chat = el("div", { className: "poproom-chat" }, "poproom-chat");
  frame.append(side, chat);
  o.root.replaceChildren(frame);

  let stage: StageState | null = null;
  let selfCatching = false;
  let queued = false;
  const draw = (): void => {
    queued = false;
    if (stage !== null) o.stage.render(stage, selfCatching);
  };
  const request = (): void => {
    if (queued) return;
    queued = true;
    o.requestFrame(draw);
  };

  const onRoom = (m: RoomSideMessage): void => {
    switch (m.t) {
      case "room-view":
        stage = stageOf(m, stage?.room ?? null);
        request();
        return;
      case "room-tv":
        plate.hidden = !m.video;
        if (m.video) {
          const text = plateText(m);
          if (plate.textContent !== text) plate.textContent = text;
        }
        if (m.catching !== selfCatching) {
          selfCatching = m.catching;
          request();
        }
        return;
      case "room-emote":
        // Over the avatar as the room is now: a member who just came in may not be drawn yet.
        if (queued) draw();
        o.stage.emote(m.member, m.kind);
        return;
      case "room-raise":
        o.focusWindow();
        return;
    }
  };

  const view = createPopoutView({
    root: chat,
    document: o.document,
    pop: o.pop,
    roomId: o.roomId,
    kind: "room",
    onRoom,
    // The room tab gone: the room here is a picture of the past; nothing in it can be pressed.
    onGone: (gone) => {
      side.toggleAttribute("inert", gone);
    },
    channel: o.channel,
    closeWindow: o.closeWindow,
    navigate: o.navigate,
    now: o.now,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
    setInterval: o.setInterval,
  });

  o.stage.root.addEventListener("click", (ev) => {
    if (!(ev.target instanceof Element)) return;
    const seat = Number(ev.target.closest<HTMLElement>("[data-seat]")?.dataset["seat"] ?? NaN);
    if (Number.isInteger(seat)) view.sit(seat);
  });

  const fit = (): void => {
    const { w, h } = o.size();
    const l = popRoomLayout(w, h);
    Object.assign(clip.style, { left: `${String(l.stage.x)}px`, top: `${String(l.stage.y)}px`, width: `${String(l.stage.w)}px`, height: `${String(l.stage.h)}px` });
    o.stage.root.style.transform = `scale(${String(l.scale)})`;
    side.style.width = `${String(l.chat.x)}px`;
    chat.style.width = `${String(l.chat.w)}px`;
  };
  fit();

  return { key: (ev) => view.key(ev), bye: () => { view.bye(); }, fit };
}
