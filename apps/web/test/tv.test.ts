import { describe, expect, test } from "bun:test";
import { NOCOOKIE_ORIGIN, tvFrame } from "../src/tv";

const good = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" };
const ORIGIN = "http://localhost:5173";

describe("tvFrame", () => {
  test("src is the nocookie embed with exactly the fixed player parameters", () => {
    const f = tvFrame(good, ORIGIN);
    expect(f).not.toBeNull();
    if (f === null) return;
    const src = new URL(f.src);
    expect(src.origin).toBe("https://www.youtube-nocookie.com");
    expect(NOCOOKIE_ORIGIN).toBe("https://www.youtube-nocookie.com");
    expect(src.pathname).toBe("/embed/dQw4w9WgXcQ");
    expect(src.hash).toBe("");
    expect(Object.fromEntries(src.searchParams)).toEqual({
      enablejsapi: "1",
      origin: ORIGIN,
      controls: "0",
      disablekb: "1",
      playsinline: "1",
      rel: "0",
      autoplay: "1",
    });
    expect([...src.searchParams.keys()]).toHaveLength(7);
  });

  test("Twitch and Vimeo embeds render nothing until their frames land (OME-124)", () => {
    const twitch = { provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" };
    const vimeo = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" };
    expect(tvFrame(twitch, ORIGIN)).toBeNull();
    expect(tvFrame(vimeo, ORIGIN)).toBeNull();
  });

  test("the nocookie flag off keeps the canonical www.youtube.com host", () => {
    const f = tvFrame(good, ORIGIN, false);
    expect(f).not.toBeNull();
    if (f === null) return;
    const src = new URL(f.src);
    expect(src.origin + src.pathname).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(src.searchParams.get("enablejsapi")).toBe("1");
    expect(src.searchParams.get("origin")).toBe(ORIGIN);
  });

  test("sandbox allows popups for YouTube's own links, but no forms, modals or top navigation", () => {
    const f = tvFrame(good, ORIGIN);
    expect(f).not.toBeNull();
    if (f === null) return;
    expect(f.sandbox.split(" ").sort()).toEqual([
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-presentation",
      "allow-same-origin",
      "allow-scripts",
    ]);
    expect(f.allow).toBe("autoplay; encrypted-media; picture-in-picture; fullscreen");
    expect(f.referrerPolicy).toBe("strict-origin-when-cross-origin");
  });

  test("the origin parameter is the page origin only, never a path or query", () => {
    const f = tvFrame(good, "http://localhost:5173/rooms/lobby?x=1");
    expect(f).not.toBeNull();
    if (f === null) return;
    expect(new URL(f.src).searchParams.get("origin")).toBe(ORIGIN);
  });

  test("an origin that is not http(s) renders nothing", () => {
    for (const o of ["", "null", "javascript:alert(1)", "file:///x"]) expect(tvFrame(good, o)).toBeNull();
  });

  test("anything that is not a canonical allowlisted embed renders nothing", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      { ...good, url: "https://evil.example/embed/dQw4w9WgXcQ" },
      { ...good, url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" },
      { ...good, url: "javascript:alert(1)" },
      { ...good, provider: "vimeo" },
      { ...good, videoId: "videoseries", url: "https://www.youtube.com/embed/videoseries" },
      { ...good, videoId: "../../../x", url: "https://www.youtube.com/embed/../../../x" },
      { ...good, url: "https://www.youtube.com/embed/dQw4w9WgXcQ?list=x" },
      { ...good, url: "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=0" },
    ];
    for (const b of bad) expect(tvFrame(b, ORIGIN)).toBeNull();
  });
});
