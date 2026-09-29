import { describe, expect, test } from "bun:test";
import { tvFrame } from "../src/tv";

const good = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" };

describe("tvFrame", () => {
  test("an allowlisted embed gets a youtube embed src with a restrictive sandbox", () => {
    const f = tvFrame(good);
    expect(f).not.toBeNull();
    if (f === null) return;
    const src = new URL(f.src);
    expect(src.origin + src.pathname).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(f.sandbox.split(" ").sort()).toEqual(["allow-presentation", "allow-same-origin", "allow-scripts"]);
    expect(f.sandbox).not.toContain("allow-top-navigation");
    expect(f.sandbox).not.toContain("allow-popups");
    expect(f.sandbox).not.toContain("allow-forms");
    expect(f.allow).not.toMatch(/camera|microphone|geolocation|usb|payment/);
    expect(f.referrerPolicy).toBe("strict-origin-when-cross-origin");
  });

  test("anything that is not a canonical allowlisted embed renders nothing", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      { ...good, url: "https://evil.example/embed/dQw4w9WgXcQ" },
      { ...good, url: "javascript:alert(1)" },
      { ...good, provider: "vimeo" },
      { ...good, videoId: "videoseries", url: "https://www.youtube.com/embed/videoseries" },
      { ...good, videoId: "../../../x", url: "https://www.youtube.com/embed/../../../x" },
      { ...good, url: "https://www.youtube.com/embed/dQw4w9WgXcQ?list=x" },
    ];
    for (const b of bad) expect(tvFrame(b)).toBeNull();
  });
});
