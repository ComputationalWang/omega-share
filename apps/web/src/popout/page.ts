// The pop-out chat window's entry (OME-598, M7 W3): `chat.html`, opened by the room tab with noopener. Its own small
// chunk: the chat log, the emote picker and the channel. No socket, no Pixi, no provider SDK.
import { browserChannel, channelName, randomId, readPopoutHash } from "./channel";
import { createPopoutView } from "./view";

const root = document.querySelector("#popout");
const at = readPopoutHash(location.hash);
if (root instanceof HTMLElement && at !== null && typeof BroadcastChannel === "function") {
  const view = createPopoutView({
    root,
    document,
    pop: randomId("p"),
    roomId: at.roomId,
    channel: browserChannel(channelName(at.roomId, at.tab)),
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
  window.addEventListener("keydown", (ev) => {
    if (view.key(ev)) ev.preventDefault();
  });
  window.addEventListener("pagehide", () => {
    view.bye();
  });
}
