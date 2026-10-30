import { describe, expect, test } from "bun:test";
import { type FrameRelayDeps, createFrameRelay } from "../src/frame-relay";

// ADR 0057 §3 and §5 (OME-1974): the background attaches the frame script, relays both ways and detaches it.
const OUR = "https://omega.example";
const HOST = "kwik.cx";
const TAB = 7;
const FRAME = 3;

function harness(over: Partial<FrameRelayDeps> & { unlocked?: string | undefined } = {}) {
  const unlocked = "unlocked" in over ? over.unlocked : HOST;
  const injected: [number, string][] = [];
  const toFrames: [number, unknown, number | undefined][] = [];
  const notes: [number, unknown][] = [];
  const deps: FrameRelayDeps = {
    ourOrigin: () => Promise.resolve(OUR),
    unlockedHost: (tabId) => Promise.resolve(tabId === TAB ? unlocked : undefined),
    inject: (tabId, host) => (injected.push([tabId, host]), Promise.resolve()),
    toFrames: (tabId, message, frameId) => (toFrames.push([tabId, message, frameId]), Promise.resolve()),
    notify: (tabId, message) => (notes.push([tabId, message]), Promise.resolve()),
    ...over,
  };
  return { relay: createFrameRelay(deps), injected, toFrames, notes };
}

const page = { tab: { id: TAB, url: `${OUR}/r/lobby` }, frameId: 0, url: `${OUR}/r/lobby` };
const frame = (frameId = FRAME, origin = `https://${HOST}`) => ({ tab: { id: TAB, url: `${OUR}/r/lobby` }, frameId, origin, url: `${origin}/e/ockxKpNdX2Kh` });
const attach = (host = HOST) => ({ source: "omega-share", kind: "attach", host });
const play = (host = HOST) => ({ source: "omega-share", kind: "frame-command", host, op: "play" });
const state = (host = HOST) => ({ source: "omega-share", kind: "frame-state", host, state: "playing", position: 12.5, rate: 1, duration: 1370, live: false, muted: false });
const intent = { source: "omega-share", kind: "frame-intent", host: HOST, playing: false, position: 30 };
const lost = { source: "omega-share", kind: "frame-lost", host: HOST };
const detach = { source: "omega-share", kind: "frame-detach" };

describe("attach", () => {
  test("injects the frame script into the room tab for the tab's unlocked host", async () => {
    const h = harness();
    await h.relay.onMessage(attach(), page);
    expect(h.injected).toEqual([[TAB, HOST]]);
  });

  test("nothing for a host the tab hasn't unlocked, a tab without an unlock, or a sender that isn't our room page", async () => {
    const h = harness();
    await h.relay.onMessage(attach("other-host.net"), page);
    await h.relay.onMessage(attach(), { ...page, tab: { id: 8, url: `${OUR}/r/two` } });
    await h.relay.onMessage(attach(), { ...page, tab: { id: TAB, url: "https://evil.example/r/lobby" } });
    await h.relay.onMessage(attach(), { ...page, frameId: 2 });
    await h.relay.onMessage({ ...attach(), extra: 1 }, page);
    expect(h.injected).toEqual([]);
    const locked = harness({ unlocked: undefined });
    await locked.relay.onMessage(attach(), page);
    expect(locked.injected).toEqual([]);
  });

  test("a failed injection is swallowed (the page times out to unsynced)", async () => {
    const h = harness({ inject: () => Promise.reject(new Error("Cannot access contents")) });
    await h.relay.onMessage(attach(), page);
  });
});

describe("frame → page", () => {
  test("frame-state, frame-intent and frame-lost reach the room page's top frame, parsed", async () => {
    const h = harness();
    await h.relay.onMessage(state(), frame());
    await h.relay.onMessage(intent, frame());
    await h.relay.onMessage(lost, frame());
    expect(h.notes).toEqual([
      [TAB, state()],
      [TAB, intent],
      [TAB, lost],
    ]);
  });

  test("sender checks: the top frame, another origin, another host, a tab without that unlock, or a bad shape get nothing through", async () => {
    const h = harness();
    await h.relay.onMessage(state(), frame(0));
    await h.relay.onMessage(state(), frame(FRAME, "https://evil.example"));
    await h.relay.onMessage(state(), frame(FRAME, "http://kwik.cx"));
    await h.relay.onMessage(state("other-host.net"), frame(FRAME, "https://other-host.net"));
    await h.relay.onMessage(state(), { ...frame(), tab: { id: 8, url: `${OUR}/r/two` } });
    await h.relay.onMessage({ ...state(), position: Number.NaN }, frame());
    await h.relay.onMessage({ ...state(), rate: 16 }, frame());
    await h.relay.onMessage({ ...state(), position: -1 }, frame());
    await h.relay.onMessage({ ...state(), extra: "page text" }, frame());
    await h.relay.onMessage({ source: "omega-share", kind: "present", version: "1.0" }, frame());
    expect(h.notes).toEqual([]);
  });

  test("Firefox has no sender.origin: the frame's URL gives it", async () => {
    const h = harness();
    const noOrigin = { ...frame(), origin: undefined };
    await h.relay.onMessage(state(), noOrigin);
    await h.relay.onMessage(state(), { ...noOrigin, url: "https://evil.example/e/1" });
    expect(h.notes).toEqual([[TAB, state()]]);
  });

  test("the first frame to report wins; another frame is ignored until the first is lost", async () => {
    const h = harness();
    await h.relay.onMessage(state(), frame(FRAME));
    await h.relay.onMessage(state(), frame(9));
    expect(h.notes).toHaveLength(1);
    await h.relay.onMessage(lost, frame(FRAME));
    await h.relay.onMessage(state(), frame(9));
    expect(h.notes).toHaveLength(3);
  });
});

describe("page → frame", () => {
  test("a frame-command goes to the reporting frame only", async () => {
    const h = harness();
    await h.relay.onMessage(state(), frame());
    await h.relay.onMessage(play(), page);
    expect(h.toFrames).toEqual([[TAB, play(), FRAME]]);
  });

  test("before any report (or after the background restarted) it goes to the tab's frames, which only the attached one obeys", async () => {
    const h = harness();
    await h.relay.onMessage(play(), page);
    expect(h.toFrames).toEqual([[TAB, play(), undefined]]);
  });

  test("not for another host, another tab or a frame's own sender", async () => {
    const h = harness();
    await h.relay.onMessage(play("other-host.net"), page);
    await h.relay.onMessage(play(), frame());
    await h.relay.onMessage(play(), { ...page, tab: { id: 8, url: `${OUR}/r/two` } });
    expect(h.toFrames).toEqual([]);
  });
});

describe("detach", () => {
  test("relock, a new unlock and a new attach detach the old script and forget its frame", async () => {
    for (const message of [{ source: "omega-share", kind: "relock" }, { source: "omega-share", kind: "unlock", host: "other-host.net" }, attach()]) {
      const h = harness();
      await h.relay.onMessage(state(), frame());
      await h.relay.onMessage(message, page);
      expect(h.toFrames).toEqual([[TAB, detach, undefined]]);
      await h.relay.onMessage(state(), frame(9));
      expect(h.notes).toHaveLength(2);
    }
  });

  test("a closed or navigated tab forgets its frame", async () => {
    const h = harness();
    await h.relay.onMessage(state(), frame());
    h.relay.tabGone(TAB);
    await h.relay.onMessage(state(), frame(9));
    expect(h.notes).toHaveLength(2);
  });
});
