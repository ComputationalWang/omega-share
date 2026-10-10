import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { cumulativeLayoutShift, gzipBytes, landingTransfer, longestTaskBefore, median, transferNote } from "./landing";

describe("landingTransfer (OME-763)", () => {
  test("counts every static response and leaves API calls, websockets and data: URLs out", () => {
    const t = landingTransfer([
      { url: "http://localhost:5183/", type: "document", bytes: 2048 },
      { url: "http://localhost:5183/assets/index-a1.js", type: "script", bytes: 10240 },
      { url: "http://localhost:5183/assets/index-b2.css", type: "stylesheet", bytes: 1024 },
      { url: "http://localhost:5183/assets/font.woff2", type: "font", bytes: 1024 },
      { url: "http://localhost:5183/logo.png", type: "image", bytes: 512 },
      { url: "http://localhost:5183/favicon.ico", type: "other", bytes: 512 },
      { url: "http://localhost:8797/rooms", type: "fetch", bytes: 4096 },
      { url: "http://localhost:8797/x", type: "xhr", bytes: 4096 },
      { url: "ws://localhost:8797/ws", type: "websocket", bytes: 4096 },
      { url: "data:image/png;base64,AAAA", type: "image", bytes: 4096 },
    ]);
    expect(t.kb).toBe(15);
    expect(t.counted.map((r) => r.type)).toEqual(["document", "script", "stylesheet", "font", "image", "other"]);
    expect(t.api.map((r) => r.url)).toEqual(["http://localhost:8797/rooms", "http://localhost:8797/x"]);
  });

  test("a room or Pixi chunk fetched before interaction counts like any other script", () => {
    const base = [{ url: "http://h/assets/index-a1.js", type: "script", bytes: 1024 }];
    const warmed = [...base, { url: "http://h/assets/room-c3.js", type: "script", bytes: 99 * 1024 }];
    expect(landingTransfer(warmed).kb - landingTransfer(base).kb).toBe(99);
  });

  test("the note breaks transfer down by type, names the scripts and lists uncounted API calls", () => {
    const note = transferNote(
      landingTransfer([
        { url: "http://h/", type: "document", bytes: 1024 },
        { url: "http://h/assets/index-a1.js", type: "script", bytes: 2048 },
        { url: "http://h/assets/home-d4.js", type: "script", bytes: 1024 },
        { url: "http://s/rooms?x=1", type: "fetch", bytes: 512 },
      ]),
    );
    expect(note).toContain("3 files");
    expect(note).toContain("script 3.0 KB");
    expect(note).toContain("document 1.0 KB");
    expect(note).toContain("index-a1.js");
    expect(note).toContain("home-d4.js");
    expect(note).toContain("not counted");
    expect(note).toContain("/rooms");
  });
});

describe("gzipBytes", () => {
  test("is the zlib level-6 gzip size of the body", () => {
    const body = new TextEncoder().encode("omega ".repeat(500));
    expect(gzipBytes(body)).toBe(gzipSync(body, { level: 6 }).byteLength);
    expect(gzipBytes(body)).toBeLessThan(body.byteLength);
  });
});

describe("cumulativeLayoutShift", () => {
  test("sums shifts without recent input and ignores the ones after input", () => {
    expect(cumulativeLayoutShift([])).toBe(0);
    expect(cumulativeLayoutShift([{ value: 0.02, hadRecentInput: false }, { value: 0.5, hadRecentInput: true }, { value: 0.01, hadRecentInput: false }])).toBeCloseTo(0.03, 10);
  });
});

describe("longestTaskBefore", () => {
  test("is the longest task starting before the field is usable, 0 when there is none", () => {
    const tasks = [{ startTime: 10, duration: 60 }, { startTime: 100, duration: 80 }, { startTime: 300, duration: 200 }];
    expect(longestTaskBefore(tasks, 250)).toBe(80);
    expect(longestTaskBefore(tasks, 50)).toBe(60);
    expect(longestTaskBefore(tasks, 5)).toBe(0);
    expect(longestTaskBefore([], 1000)).toBe(0);
  });
});

describe("median", () => {
  test("middle value, mean of the two middles for an even count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow();
  });
});
