import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PlaybackController, PlaybackView } from "../src/controls/playback";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-1246 (S2): a non-live text near the TV says what plays, for a screen reader. It follows the room's state, not
// the clock: while playing it doesn't name the position, so it doesn't change every second.

const base: PlaybackView = {
  hasVideo: true,
  canControl: true,
  playing: false,
  position: 83,
  duration: 200,
  volume: 100,
  muted: false,
  needsUnmute: false,
  unmuteInPlayer: false,
  catching: false,
  error: null,
  provider: "youtube",
  live: false,
  seekOnly: false,
  policy: "everyone",
  held: false,
  qualities: [],
  quality: null,
};

async function setup() {
  const { createTransport } = await import("../src/controls/dom");
  const c = { togglePlay: () => true, seek: () => true } as Pick<PlaybackController, "togglePlay" | "seek">;
  const t = createTransport(c);
  document.body.replaceChildren(t.root);
  const text = (): string | null => t.root.querySelector("[data-testid=now-playing]")?.textContent ?? null;
  const node = t.root.querySelector("[data-testid=now-playing]");
  return { t, text, node };
}

describe("now playing", () => {
  test("paused: the provider and the position; not a live region", async () => {
    const { t, text, node } = await setup();
    t.update(base);
    expect(text()).toBe("YouTube video, paused at 1:23");
    expect(node?.getAttribute("aria-live")).toBeNull();
    expect(node?.getAttribute("role")).toBeNull();
  });

  test("playing: no position, so the text holds still while the clock runs", async () => {
    const { t, text } = await setup();
    t.update({ ...base, playing: true, position: 10 });
    expect(text()).toBe("YouTube video, playing");
    t.update({ ...base, playing: true, position: 11 });
    expect(text()).toBe("YouTube video, playing");
  });

  test("a live stream, and no video", async () => {
    const { t, text } = await setup();
    t.update({ ...base, provider: "twitch", live: true, playing: true });
    expect(text()).toBe("Twitch live stream, playing");
    t.update({ ...base, provider: "twitch", live: true, playing: false });
    expect(text()).toBe("Twitch live stream, paused");
    t.update({ ...base, provider: null, hasVideo: false });
    expect(text()).toBe("");
  });
});
