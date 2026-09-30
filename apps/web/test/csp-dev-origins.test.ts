import { describe, expect, test } from "bun:test";
import { devConnectSrc, withConnectSrc } from "../csp";

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

describe("devConnectSrc", () => {
  test("defaults match the pinned index.html origins", () => {
    expect(devConnectSrc({})).toEqual(["ws://localhost:8787", "http://localhost:8787", "ws://localhost:5173"]);
  });
  test("alt ports follow VITE_SERVER_URL and the web port", () => {
    expect(devConnectSrc({ serverUrl: "http://localhost:8807", webPort: 5193 })).toEqual([
      "ws://localhost:8807",
      "http://localhost:8807",
      "ws://localhost:5193",
    ]);
  });
  test("an https server URL becomes wss + https (path ignored)", () => {
    expect(devConnectSrc({ serverUrl: "https://omega.example/some/path" })).toEqual([
      "wss://omega.example",
      "https://omega.example",
      "ws://localhost:5173",
    ]);
  });
  test("a non-http(s) or malformed server URL is ignored", () => {
    for (const serverUrl of ["javascript:alert(1)", "ftp://x.example", "not a url", "", "https://a.example; script-src *"]) {
      expect(devConnectSrc({ serverUrl })).toEqual(["ws://localhost:8787", "http://localhost:8787", "ws://localhost:5173"]);
    }
  });
  test("an invalid web port is ignored", () => {
    expect(devConnectSrc({ webPort: 0 })[2]).toBe("ws://localhost:5173");
    expect(devConnectSrc({ webPort: Number.NaN })[2]).toBe("ws://localhost:5173");
  });
});

describe("withConnectSrc", () => {
  test("default sources leave index.html byte-identical", () => {
    expect(withConnectSrc(html, devConnectSrc({}))).toBe(html);
  });
  test("rewrites only the dev origins in connect-src", () => {
    const out = withConnectSrc(html, devConnectSrc({ serverUrl: "http://localhost:8807", webPort: 5193 }));
    expect(out).toContain("connect-src 'self' ws://localhost:8807 http://localhost:8807 ws://localhost:5193;");
    expect(out.replace(/connect-src [^;]+;/, "")).toBe(html.replace(/connect-src [^;]+;/, ""));
  });
  test("throws when there is no connect-src to rewrite", () => {
    expect(() => withConnectSrc("<html></html>", [])).toThrow();
  });
});
