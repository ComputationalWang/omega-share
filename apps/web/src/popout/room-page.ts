// The whole-room pop-out window's entry (OME-600, M7 W3b): `room.html`, opened by the room tab with noopener. Its own
// chunk: the stage (Pixi, the one renderer while the room is out here), the chat column and the channel. No socket, no
// provider SDK.
import "pixi.js/unsafe-eval";
import type { RoomId } from "@omega/shared";
import { el } from "../controls/dom";
import { layoutOf } from "../furniture";
import { initialState, type StageState } from "../state";
import { createStage } from "../stage";
import { browserChannel, channelName, randomId, readPopoutHash } from "./channel";
import { createRoomPopout } from "./room-pop";

async function start(root: HTMLElement, roomId: RoomId, tab: string): Promise<void> {
  let shown: StageState = initialState;
  let selfCatching = false;
  let atlasFrame = 0;
  const stage = await createStage({
    reducedMotion: globalThis.matchMedia("(prefers-reduced-motion: reduce)"),
    // The furniture atlas arrived: draw the room as last shown, on the next frame.
    requestRender: () => {
      if (atlasFrame !== 0) return;
      atlasFrame = requestAnimationFrame(() => {
        atlasFrame = 0;
        stage?.render(shown, layoutOf(shown.room), selfCatching);
      });
    },
  }).catch((e: unknown) => {
    // No renderer here (Pixi couldn't start): say so, and never say ready, so the room stays in its tab (review).
    console.warn("the room window could not start", e);
    root.replaceChildren(el("p", { className: "ui-panel popout-failed", role: "alert", textContent: "This window couldn't draw the room. Close it: the room is still in its tab." }));
    return null;
  });
  if (stage === null) return;
  const popout = createRoomPopout({
    root,
    document,
    pop: randomId("p"),
    roomId,
    channel: browserChannel(channelName(roomId, tab)),
    stage: {
      root: stage.root,
      render: (s, catching) => {
        shown = s;
        selfCatching = catching;
        stage.render(s, layoutOf(s.room), catching);
      },
      emote: (id, kind) => {
        stage.emote(id, kind, shown);
      },
    },
    size: () => ({ w: root.clientWidth, h: root.clientHeight }),
    requestFrame: (cb) => requestAnimationFrame(cb),
    focusWindow: () => {
      window.focus();
    },
    closeWindow: () => {
      window.close();
    },
    navigate: (url) => {
      location.assign(url);
    },
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h);
      clearInterval(h);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
  });
  new ResizeObserver(() => {
    popout.fit();
  }).observe(root);
  window.addEventListener("keydown", (ev) => {
    if (popout.key(ev)) ev.preventDefault();
  });
  window.addEventListener("pagehide", () => {
    popout.bye();
  });
}

const root = document.querySelector("#popout");
const at = readPopoutHash(location.hash);
if (root instanceof HTMLElement && at !== null && typeof BroadcastChannel === "function") void start(root, at.roomId, at.tab);
