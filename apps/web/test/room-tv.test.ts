import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AnyEmbed, Member, RoomState } from "@omega/shared";
import { createPlaybackController } from "../src/controls/playback";
import type { ExtensionBridge, FrameMessage, FrameToExtension } from "../src/extension-bridge";
import { initialState, reduce, type ViewState } from "../src/state";

// OME-1100: the room's TV and its shelf, split out of room.ts. The TV follows the room's embed: nothing shared, a synced
// player, or a generic page's load card (ADR 0024 §3) with no sync chrome.

beforeAll(() => {
  // No network in tests: a script load fails the way a content blocker makes it fail (OME-1665).
  GlobalRegistrator.register({
    url: "https://omega.example/r/main",
    settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: false, navigation: { disableChildFrameNavigation: true } },
  });
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

async function setup(extension: ExtensionBridge = { whenPresent: () => undefined, unlock: () => Promise.resolve("unsupported" as const), relock: () => { relockCount++; }, toFrame: () => undefined, onFrame: () => () => undefined }) {
  const { createRoomTv } = await import("../src/room-tv");
  const playback = createPlaybackController({ send: () => true, clock: { ready: false, serverNow: () => 0, tick: () => undefined }, now: () => 0, setInterval: () => 0, clearInterval: () => undefined });
  const wrap = document.createElement("div");
  let providers = 0;
  const tv = createRoomTv({
    playback,
    extension,
    wrap,
    fullscreen: () => false,
    onProvider: () => { providers++; },
    onCurtain: () => undefined,
  });
  wrap.append(tv.tv, tv.controls);
  document.body.replaceChildren(wrap, tv.personal);
  return { tv, playback, fsKey: tv.fsKey, relocks: () => relockCount, providers: () => providers };
}
let relockCount = 0;

describe("room TV", () => {
  test("nothing shared: the empty card, and the synced shelf ends with the full-screen key", async () => {
    const { tv, fsKey } = await setup();
    tv.sync(withEmbed(null));
    expect(tv.tv.textContent).toContain("Nothing on yet");
    expect(tv.controls.lastElementChild).toBe(fsKey);
    expect(tv.controls.childElementCount).toBeGreaterThan(1);
    expect(tv.provider()).toBeNull();
  });

  test("nothing on: the closed curtain fills the TV, its line the only text (OME-1812, design OME-1799 §5)", async () => {
    const { tv } = await setup();
    tv.sync(withEmbed(null));
    const curtain = tv.tv.querySelector(".tv-curtain");
    expect(curtain).not.toBeNull();
    expect(tv.tv.firstElementChild).toBe(curtain);
    expect(curtain?.querySelector("button")?.textContent).toBe("Nothing on yet. Paste a link in Up next to raise the curtain.");
    expect(tv.empty()).toBe(true);
  });

  test("the curtain goes when something loads and comes back when it ends", async () => {
    const { tv } = await setup();
    tv.sync(withEmbed(page));
    expect(tv.tv.querySelector(".tv-curtain")).toBeNull();
    expect(tv.empty()).toBe(false);
    tv.sync(withEmbed(null));
    expect(tv.tv.querySelector(".tv-curtain")).not.toBeNull();
    expect(tv.empty()).toBe(true);
  });

  test("a generic page: its load card, no sync chrome, and the shelf is the strip and the full-screen key", async () => {
    relockCount = 0;
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

  test("a Twitch VOD whose player API is blocked still plays, unsynced, in a plain player iframe (OME-1665)", async () => {
    // happy-dom reports the blocked script on the real console; keep it out of the run's output (OME-1746).
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    const { tv } = await setup();
    tv.sync(withEmbed({ provider: "twitch", kind: "vod", videoId: "1234567890", url: "https://player.twitch.tv/?video=v1234567890" }));
    for (let i = 0; i < 100 && tv.notice.hidden; i++) await new Promise((r) => setTimeout(r, 10));
    const errors = logged.mock.calls.map(([e]: unknown[]) => (e instanceof Error ? e.name : e));
    logged.mockRestore();
    expect(errors).toEqual(["NotSupportedError"]);
    expect(tv.notice.hidden).toBe(false);
    expect(tv.notice.textContent).toContain("The video plays here without sync");
    const frames = tv.tv.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    const src = new URL(frames[0]?.getAttribute("src") ?? "");
    expect(src.origin).toBe("https://player.twitch.tv");
    expect(src.searchParams.get("video")).toBe("v1234567890");
    expect(src.searchParams.get("parent")).toBe("omega.example");
    expect(frames[0]?.getAttribute("sandbox")).toContain("allow-scripts");
  });

  // ADR 0057 §4: unlocked and loaded, the page's frame gets the frame adapter; while it's attached the sync shelf is back.
  test("a generic page with the extension: attach after the unlocked frame loads, sync shelf while attached", async () => {
    const toFrame: FrameToExtension[] = [];
    const link: { cb: ((m: FrameMessage) => void) | null } = { cb: null };
    const { tv, playback } = await setup({
      whenPresent: (cb) => {
        cb();
      },
      unlock: () => Promise.resolve("unlocked" as const),
      relock: () => undefined,
      toFrame: (m) => toFrame.push(m),
      onFrame: (cb) => {
        link.cb = cb;
        return () => undefined;
      },
    });
    const s = withEmbed(page);
    playback.setRoom({ embed: page, playback: null, itemId: "q1" });
    tv.sync(s);
    tv.tv.querySelector<HTMLButtonElement>("[data-testid=generic-unlock]")?.click();
    await Promise.resolve();
    await Promise.resolve();
    tv.tv.querySelector("iframe")?.dispatchEvent(new Event("load"));
    for (let i = 0; i < 100 && toFrame.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(toFrame).toEqual([{ source: "omega-share", kind: "attach", host: "media.example.org" }]);
    const deliver = (m: unknown) => link.cb?.(m as FrameMessage);
    deliver({ source: "omega-share", kind: "frame-state", host: "media.example.org", state: "paused", position: 0, rate: 1, duration: 60, live: false, muted: false });
    for (let i = 0; i < 100 && !playback.view().hasVideo; i++) await new Promise((r) => setTimeout(r, 10));
    expect(tv.personal.hidden).toBe(false);
    expect(tv.controls.childElementCount).toBeGreaterThan(2);
    expect(tv.controls.querySelector("[data-testid=synced]")?.textContent).toBe("Synced");
    expect(playback.view().hasVideo).toBe(true);
    deliver({ source: "omega-share", kind: "frame-lost", host: "media.example.org" });
    expect(tv.personal.hidden).toBe(true);
    expect(tv.controls.childElementCount).toBe(2);
    expect(tv.controls.querySelector("[data-testid=not-synced]")?.textContent).toBe("Not synced");
  });
});
