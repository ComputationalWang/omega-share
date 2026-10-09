// The whole-room pop-out window's entry (OME-600, M7 W3b): `room.html`, opened by the room tab with noopener. Its own
// chunk: the stage (Pixi, the one renderer while the room is out here), the chat column and the channel. No socket, no
// provider SDK.
import "pixi.js/unsafe-eval";
import { layoutOf } from "../furniture";
import { initialState, type StageState } from "../state";
import { createStage } from "../stage";
import { browserChannel, channelName, randomId, readPopoutHash } from "./channel";
import { createRoomPopout } from "./room-pop";

const root = document.querySelector("#popout");
const at = readPopoutHash(location.hash);
if (root instanceof HTMLElement && at !== null && typeof BroadcastChannel === "function") {
  let shown: StageState = initialState;
  let redraw = (): void => undefined;
  const stage = await createStage({
    reducedMotion: globalThis.matchMedia("(prefers-reduced-motion: reduce)"),
    requestRender: () => {
      redraw();
    },
  });
  let selfCatching = false;
  const popout = createRoomPopout({
    root,
    document,
    pop: randomId("p"),
    roomId: at.roomId,
    channel: browserChannel(channelName(at.roomId, at.tab)),
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
  // The furniture atlas arrived: draw the room as last shown, on the next frame.
  redraw = () => {
    requestAnimationFrame(() => {
      stage.render(shown, layoutOf(shown.room), selfCatching);
    });
  };
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
