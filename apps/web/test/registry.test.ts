import { describe, expect, test } from "bun:test";
import type { Embed } from "@omega/shared";
import { PLAYERS, createPlayerMounter, type AdapterFactory, type AdapterRegistry, type MountContext, type MountResult } from "../src/player/registry";
import { tvFrame } from "../src/tv";
import { FakePlayer } from "./support/fake-player";

const ORIGIN = "http://localhost:5173";
const youtube = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" } as const;
const vimeo = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" } as const;
const twitch = { provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" } as const;

function ctx(embed: Embed): MountContext {
  const frame = tvFrame(embed, ORIGIN);
  if (frame === null) throw new Error("no frame");
  return { embed, frame, target: { iframe: null, container: {} as HTMLElement }, now: () => 0 };
}

/** A registry of fakes that records which provider modules were loaded and what each factory saw. */
function fakes(fail: Partial<Record<Embed["provider"], number>> = {}) {
  const loads: string[] = [];
  const seen: MountContext[] = [];
  const factory: AdapterFactory = (c) => {
    seen.push(c);
    return Promise.resolve({ ok: true, player: new FakePlayer({ now: c.now }) });
  };
  const importer = (p: Embed["provider"]) => () => {
    loads.push(p);
    const left = fail[p] ?? 0;
    if (left > 0) {
      fail[p] = left - 1;
      return Promise.reject(new Error("chunk failed"));
    }
    return Promise.resolve(factory);
  };
  const reg: AdapterRegistry = { youtube: importer("youtube"), twitch: importer("twitch"), vimeo: importer("vimeo") };
  return { reg, loads, seen };
}

describe("createPlayerMounter", () => {
  test("loads only the shown embed's provider module, once, and hands it the embed, frame and target", async () => {
    const f = fakes();
    const mount = createPlayerMounter(f.reg);
    const c = ctx(vimeo);
    const r = await mount(c);
    expect(r.ok).toBe(true);
    expect(f.loads).toEqual(["vimeo"]);
    expect(f.seen).toEqual([c]);
    await mount(ctx(vimeo));
    expect(f.loads).toEqual(["vimeo"]);
    await mount(ctx(youtube));
    expect(f.loads).toEqual(["vimeo", "youtube"]);
  });

  test("a provider module that fails to load → load-failed, and the next mount retries", async () => {
    const f = fakes({ twitch: 1 });
    const mount = createPlayerMounter(f.reg);
    expect(await mount(ctx(twitch))).toEqual({ ok: false, reason: "load-failed" });
    expect((await mount(ctx(twitch))).ok).toBe(true);
    expect(f.loads).toEqual(["twitch", "twitch"]);
  });

  test("a factory that throws (SDK constructor error) → load-failed, never a rejected mount", async () => {
    const throwing: AdapterFactory = () => Promise.reject(new Error("Twitch.Player is not a constructor"));
    const sync: AdapterFactory = () => {
      throw new Error("boom");
    };
    const mount = createPlayerMounter({ youtube: () => Promise.resolve(sync), twitch: () => Promise.resolve(throwing), vimeo: () => Promise.resolve(throwing) });
    expect(await mount(ctx(twitch))).toEqual({ ok: false, reason: "load-failed" });
    expect(await mount(ctx(vimeo))).toEqual({ ok: false, reason: "load-failed" });
    const yt: MountContext = { ...ctx(youtube), target: { iframe: {} as HTMLIFrameElement, container: {} as HTMLElement } };
    expect(await mount(yt)).toEqual({ ok: false, reason: "load-failed" });
  });

  test("a frame that doesn't belong to the embed's provider never reaches a factory", async () => {
    const f = fakes();
    const mount = createPlayerMounter(f.reg);
    const wrong = { ...ctx(twitch), embed: youtube };
    expect(await mount(wrong)).toEqual({ ok: false, reason: "invalid" });
    expect(f.loads).toEqual([]);
  });
});

describe("PLAYERS (the page's registry)", () => {
  test("Vimeo has no adapter yet (OME-126): unsupported, nothing loaded", async () => {
    const mount = createPlayerMounter(PLAYERS);
    expect(await mount(ctx(vimeo))).toEqual({ ok: false, reason: "unsupported" });
  });

  test("Twitch is the SDK adapter (OME-125): handed an iframe instead of a container, it refuses before the SDK loads", async () => {
    const mount = createPlayerMounter(PLAYERS);
    const c = ctx(twitch);
    expect(await mount({ ...c, target: { iframe: {} as HTMLIFrameElement, container: c.target.container } })).toEqual({ ok: false, reason: "invalid" });
  });

  test("YouTube without our iframe is refused before the IFrame API loads", async () => {
    const mount = createPlayerMounter(PLAYERS);
    expect(await mount(ctx(youtube))).toEqual({ ok: false, reason: "invalid" });
  });
});
