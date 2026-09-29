import { describe, expect, test } from "bun:test";
import { DEFAULT_SERVER_BASE_URL, hostPermissionPattern, parseServerBaseUrl, readServerBaseUrl } from "../src/settings";

describe("parseServerBaseUrl", () => {
  const ok: readonly [string, string][] = [
    ["http://localhost:8787", "http://localhost:8787"],
    ["  http://localhost:8787/  ", "http://localhost:8787"],
    ["https://abc123.ngrok-free.app", "https://abc123.ngrok-free.app"],
    ["HTTPS://Omega.Example.COM:443/", "https://omega.example.com"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
  ];
  for (const [input, origin] of ok) {
    test(`accepts ${JSON.stringify(input)}`, () => {
      expect(parseServerBaseUrl(input)).toEqual({ ok: true, origin });
    });
  }

  const rejected: readonly string[] = [
    "",
    "localhost:8787",
    "not a url",
    "ftp://example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "chrome-extension://abc/",
    "http://user:pw@example.com",
    "https://example.com/api",
    "https://example.com/?x=1",
    "https://example.com/#x",
    `https://${"a".repeat(2100)}.com`,
  ];
  for (const input of rejected) {
    test(`rejects ${JSON.stringify(input.slice(0, 40))}`, () => {
      const r = parseServerBaseUrl(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    });
  }
});

describe("stored setting", () => {
  test("default is the local dev server", () => {
    expect(DEFAULT_SERVER_BASE_URL).toBe("http://localhost:8787");
  });
  test("falls back to the default when nothing valid is stored", () => {
    for (const stored of [undefined, null, 42, "javascript:alert(1)", { url: "http://x" }]) {
      expect(readServerBaseUrl(stored)).toBe(DEFAULT_SERVER_BASE_URL);
    }
  });
  test("uses a valid stored origin", () => {
    expect(readServerBaseUrl("https://abc123.ngrok-free.app")).toBe("https://abc123.ngrok-free.app");
  });
  test("host permission pattern covers exactly that origin", () => {
    expect(hostPermissionPattern("http://localhost:8787")).toBe("http://localhost:8787/*");
    expect(hostPermissionPattern("https://abc123.ngrok-free.app")).toBe("https://abc123.ngrok-free.app/*");
  });
});
