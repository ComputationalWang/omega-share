import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { EmoteKind, MemberId } from "@omega/shared";
import type { PopMessage } from "../src/popout/channel";
import type { StageState } from "../src/state";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-600 (M7 W3b, set k `ui-m7-popout`): the whole-room window. The room tab keeps the one socket and the picture and
// pauses its own renderer; this window draws the room (the one renderer, moved here) from the state the tab mirrors over
// the channel, with the chat beside it and a brass plate saying where the picture is and its time. Seat clicks go back
// to the room tab. The stage itself (Pixi) is e2e-tested; here it's a stand-in that records what it was asked to draw.

const MEMBER = { id: "m1", nickname: "Ada", avatar: 2 };
const ROOM = { id: "movie-night", seats: [null, null, null, null, null, null, null, null], members: [MEMBER], embed: null, playback: null };
/** A room-view as sent when the room didn't change: everything but the room. */
function withoutRoom<T extends { room: unknown }>(v: T): Omit<T, "room"> {
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "room")) as Omit<T, "room">;
}
const VIEW = { t: "room-view", status: "open", self: "m1", room: ROOM, bubbles: [], syslines: [], catching: [] } as const;
const TV = { t: "room-tv", video: true, playing: true, position: 1531, live: false, catching: false } as const;

async function setup(size = { w: 1280, h: 668 }) {
  const { createRoomPopout } = await import("../src/popout/room-pop");
  const posted: PopMessage[] = [];
  let deliver: (data: unknown) => void = () => undefined;
  const frames: FrameRequestCallback[] = [];
  const renders: { s: StageState; selfCatching: boolean }[] = [];
  const emotes: [MemberId, EmoteKind][] = [];
  let focused = 0;
  const stageRoot = document.createElement("div");
  for (let i = 0; i < 8; i++) {
    const b = document.createElement("button");
    b.dataset["seat"] = String(i);
    b.dataset["testid"] = "seat";
    stageRoot.append(b);
  }
  const root = document.createElement("main");
  document.body.replaceChildren(root);
  const popout = createRoomPopout({
    root,
    document,
    pop: "p1",
    roomId: "movie-night",
    channel: {
      post: (m) => posted.push(m),
      onMessage: (fn) => {
        deliver = fn;
      },
      close: () => undefined,
    },
    stage: {
      root: stageRoot,
      render: (s, selfCatching) => renders.push({ s, selfCatching }),
      emote: (id, kind) => emotes.push([id, kind]),
    },
    size: () => size,
    requestFrame: (cb) => frames.push(cb),
    focusWindow: () => {
      focused++;
    },
    closeWindow: () => undefined,
    navigate: () => undefined,
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => undefined,
    setInterval: () => 0,
  });
  const from = (m: unknown): void => {
    deliver(m);
  };
  const frame = (): void => {
    for (const cb of frames.splice(0)) cb(0);
  };
  const take = (): PopMessage[] => posted.splice(0);
  const adopt = (): void => {
    from({ t: "room-adopt", pop: "p1" });
    take();
  };
  const plate = (): HTMLElement => {
    const e = root.querySelector("[data-testid=poproom-plate]");
    if (!(e instanceof HTMLElement)) throw new Error("no plate");
    return e;
  };
  return { popout, root, stageRoot, from, frame, take, adopt, renders, emotes, plate, focused: () => focused };
}

describe("whole-room window", () => {
  test("set k: the room beside the chat column; the stage sits in the room side, the chat (role=log) in the column", async () => {
    const { root, stageRoot } = await setup();
    const room = root.querySelector("[data-testid=poproom-room]");
    const chat = root.querySelector("[data-testid=poproom-chat]");
    expect(room?.contains(stageRoot)).toBe(true);
    expect(chat?.querySelector("[role=log]")).not.toBeNull();
    expect(chat?.querySelector("[data-testid=chat-input]")).not.toBeNull();
  });

  test("draws what the room tab mirrors, once per frame with the newest", async () => {
    const { from, frame, adopt, renders } = await setup();
    adopt();
    from(VIEW);
    from({ ...VIEW, bubbles: [{ memberId: "m1", text: "hi", expiresAt: 5 }] });
    expect(renders).toEqual([]);
    frame();
    expect(renders).toHaveLength(1);
    expect(renders[0]?.s.bubbles).toEqual([{ memberId: "m1", text: "hi", expiresAt: 5 }]);
    expect(renders[0]?.s.room?.members).toEqual([MEMBER]);
    frame();
    expect(renders).toHaveLength(1);
  });

  test("a room-view without the room keeps the room it has: the same object, so the stage redraws nothing it needn't (review)", async () => {
    const { from, frame, adopt, renders } = await setup();
    adopt();
    from(VIEW);
    frame();
    const rest = withoutRoom(VIEW);
    from({ ...rest, bubbles: [{ memberId: "m1", text: "hi", expiresAt: 5 }] });
    frame();
    expect(renders).toHaveLength(2);
    expect(renders[1]?.s.room).toBe(renders[0]?.s.room ?? null);
    expect(renders[1]?.s.bubbles).toHaveLength(1);
  });

  test("a malformed room is never drawn", async () => {
    const { from, frame, adopt, renders } = await setup();
    adopt();
    from({ ...VIEW, room: { ...ROOM, seats: [] } });
    frame();
    expect(renders).toEqual([]);
  });

  test("the brass plate says where the picture is and its time; paused and live say so; no video, no plate", async () => {
    const { from, adopt, plate } = await setup();
    adopt();
    expect(plate().hidden).toBe(true);
    from(TV);
    expect(plate().hidden).toBe(false);
    expect(plate().textContent).toBe("Playing on your main screen · 25:31");
    from({ ...TV, playing: false, position: 62 });
    expect(plate().textContent).toBe("Paused on your main screen · 1:02");
    from({ ...TV, live: true });
    expect(plate().textContent).toBe("Live on your main screen");
    from({ ...TV, video: false });
    expect(plate().hidden).toBe(true);
  });

  test("my own catching-up hourglass follows the room tab's player", async () => {
    const { from, frame, adopt, renders } = await setup();
    adopt();
    from(VIEW);
    from({ ...TV, catching: true });
    frame();
    expect(renders.at(-1)?.selfCatching).toBe(true);
    from({ ...TV, catching: false });
    frame();
    expect(renders.at(-1)?.selfCatching).toBe(false);
  });

  test("emotes are drawn as they come", async () => {
    const { from, adopt, emotes } = await setup();
    adopt();
    from({ t: "room-emote", member: "m1", kind: "heart" });
    expect(emotes).toEqual([["m1", "heart"]]);
  });

  test("an emote right after a change is drawn over the room as it is now: the waiting frame is drawn first", async () => {
    const { from, adopt, renders, emotes } = await setup();
    const order: string[] = [];
    adopt();
    from(VIEW);
    expect(renders).toHaveLength(0);
    from({ t: "room-emote", member: "m1", kind: "wave" });
    order.push(String(renders.length), String(emotes.length));
    expect(order).toEqual(["1", "1"]);
  });

  test("a seat click (mouse or keyboard) goes to the room tab to send", async () => {
    const { stageRoot, take, adopt } = await setup();
    adopt();
    const seat = stageRoot.querySelector<HTMLButtonElement>("[data-seat='5']");
    seat?.click();
    expect(take()).toEqual([{ t: "pop-sit", pop: "p1", seat: 5 }]);
  });

  test("show the window: the room tab asks, the window comes to the front", async () => {
    const { from, adopt, focused } = await setup();
    adopt();
    from({ t: "room-raise" });
    expect(focused()).toBe(1);
  });

  test("the room tab gone: the stage is out of reach (inert) until a room tab adopts it again", async () => {
    const { from, adopt, stageRoot } = await setup();
    adopt();
    expect(stageRoot.closest("[inert]")).toBeNull();
    from({ t: "room-gone" });
    expect(stageRoot.closest("[inert]")).not.toBeNull();
    from({ t: "room-adopt", pop: "p1" });
    expect(stageRoot.closest("[inert]")).toBeNull();
  });

  test("the stage fits inside its side's rim: 1× in the set k window, scaled down in a small one (QA OME-646)", async () => {
    const big = await setup();
    big.popout.fit();
    expect(big.stageRoot.style.transform).toBe("scale(1)");
    const small = await setup({ w: 900, h: 500 });
    small.popout.fit();
    // 900 − 300 (chat) − 12 (rim) = 588 px across for 960: 0.6125.
    expect(small.stageRoot.style.transform).toBe("scale(0.6125)");
  });
});
