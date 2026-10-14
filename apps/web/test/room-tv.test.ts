import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AnyEmbed, Member, RoomState } from "@omega/shared";
import { createPlaybackController } from "../src/controls/playback";
import { initialState, reduce, type ViewState } from "../src/state";

// OME-1100: the room's TV and its shelf, split out of room.ts. The TV follows the room's embed: nothing shared, a synced
// player, or a generic page's load card (ADR 0024 §3) with no sync chrome.

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://omega.example/r/main" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const me: Member = { id: "me", nickname: "me", avatar: 0 };
const withEmbed = (embed: AnyEmbed | null): ViewState => {
  const room: RoomState = { id: "r1", seats: [null, null], members: [me], embed: null };
  return reduce(initialState, { type: "server", msg: { type: "snapshot", self: "me", room: embed === null ? room : { ...room, embed, itemId: "q1" }, owner: false }, now: 0 });
};
const page = { provider: "generic", host: "media.example.org", url: "https://media.example.org/embed/42" } as const;

async function setup() {
  const { createRoomTv } = await import("../src/room-tv");
  const playback = createPlaybackController({ send: () => true, clock: { ready: false, serverNow: () => 0, tick: () => undefined }, now: () => 0, setInterval: () => 0, clearInterval: () => undefined });
  const fsKey = document.createElement("button");
  const wrap = document.createElement("div");
  let relocks = 0;
  let providers = 0;
  const tv = createRoomTv({
    playback,
    extension: { whenPresent: () => undefined, unlock: () => Promise.resolve("unsupported" as const), relock: () => { relocks++; } },
    fsKey,
    wrap,
    fullscreen: () => false,
    onProvider: () => { providers++; },
  });
  wrap.append(tv.tv, tv.controls);
  document.body.replaceChildren(wrap, tv.personal);
  return { tv, fsKey, relocks: () => relocks, providers: () => providers };
}

describe("room TV", () => {
  test("nothing shared: the empty card, and the synced shelf ends with the full-screen key", async () => {
    const { tv, fsKey } = await setup();
    tv.sync(withEmbed(null));
    expect(tv.tv.textContent).toContain("Share a video");
    expect(tv.controls.lastElementChild).toBe(fsKey);
    expect(tv.controls.childElementCount).toBeGreaterThan(1);
    expect(tv.provider()).toBeNull();
  });

  test("a generic page: its load card, no sync chrome, and the shelf is the strip and the full-screen key", async () => {
    const { tv, fsKey, relocks } = await setup();
    tv.sync(withEmbed(page));
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(tv.controls.childElementCount).toBe(2);
    expect(tv.controls.lastElementChild).toBe(fsKey);
    expect(tv.personal.hidden).toBe(true);
    expect(relocks()).toBe(1);
    // The same item again changes nothing.
    const card = tv.tv.firstElementChild;
    tv.sync(withEmbed(page));
    expect(tv.tv.firstElementChild).toBe(card);
    expect(relocks()).toBe(1);
  });

  test("back from a generic page to nothing: the synced shelf and your volume come back", async () => {
    const { tv } = await setup();
    tv.sync(withEmbed(page));
    tv.sync(withEmbed(null));
    expect(tv.personal.hidden).toBe(false);
    expect(tv.controls.childElementCount).toBeGreaterThan(2);
  });
});
