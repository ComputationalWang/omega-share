import { describe, expect, test } from "bun:test";
import { DEFAULT_SERVER_BASE_URL, defaultServerBaseUrl, hostPermissionPattern, ownHostsOf, parseServerBaseUrl, readServerBaseUrl } from "../src/settings";

describe("parseServerBaseUrl", () => {
  const ok: readonly [string, string][] = [
    ["http://localhost:8787", "http://localhost:8787"],
    ["  http://localhost:8787/  ", "http://localhost:8787"],
    ["https://abc123.ngrok-free.app", "https://abc123.ngrok-free.app"],
    ["HTTPS://Omega.Example.COM:443/", "https://omega.example.com"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:8787", "http://[::1]:8787"],
    ["https://example.com", "https://example.com"],
    ["https://127.0.0.1:8443", "https://127.0.0.1:8443"],
    ["https://[::1]:8443", "https://[::1]:8443"],
    ["https://omega.trycloudflare.com", "https://omega.trycloudflare.com"],
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
    // Cleartext is only for the local machine.
    "http://example.com",
    "http://abc123.ngrok-free.app",
    "http://192.168.1.10:8787",
    "http://localhost.example.com",
    // Hostile or confusing forms a tunnel URL never has.
    "   ",
    "https://",
    "https://exa\nmple.com",
    "https://exa mple.com",
    "http://localhost:8787@evil.com",
    "https://user@example.com",
    "https://:pw@example.com",
    "https://example.com\\@evil.com",
    "http://localhost%2eevil.com",
    "http://0.0.0.0:8787",
    "https://example.com.",
    "https://example.com:0",
    "data:text/html,<script>alert(1)</script>",
    // A tunnel always has a name: IP literals are refused unless they are loopback.
    "https://192.168.1.10",
    "https://10.0.0.1:8443",
    "https://8.8.8.8",
    "https://[fe80::1]",
    "https://[2001:db8::1]:8443",
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
  test("default is the local dev server outside the store build", () => {
    expect(DEFAULT_SERVER_BASE_URL).toBe("http://localhost:8787");
    for (const mode of ["development", "e2e", undefined]) expect(defaultServerBaseUrl(mode)).toBe("http://localhost:8787");
  });
  test("the production (store) build defaults to the hosted https server (R1: reviewers can't use localhost, no cleartext default)", () => {
    expect(defaultServerBaseUrl("production")).toBe("https://omega-share.duckdns.org");
  });
  test("falls back to the default when nothing valid is stored", () => {
    for (const stored of [undefined, null, 42, "javascript:alert(1)", { url: "http://x" }]) {
      expect(readServerBaseUrl(stored)).toBe(DEFAULT_SERVER_BASE_URL);
    }
  });
  test("uses a valid stored origin", () => {
    expect(readServerBaseUrl("https://abc123.ngrok-free.app")).toBe("https://abc123.ngrok-free.app");
  });
  // QA OME-687 (Firefox 157): a match pattern with a port never matches in Firefox (permissions.contains, tabs.query,
  // executeScript all fail), while a port-less one matches every port, as it does in Chrome. So the grant is the host.
  test("host permission pattern covers that origin's scheme and host, on any port", () => {
    expect(hostPermissionPattern("https://abc123.ngrok-free.app")).toBe("https://abc123.ngrok-free.app/*");
    expect(hostPermissionPattern("http://localhost:8787")).toBe("http://localhost/*");
    expect(hostPermissionPattern("https://qa682.test:8968")).toBe("https://qa682.test/*");
    expect(hostPermissionPattern("http://[::1]:8858")).toBe("http://[::1]/*");
    expect(hostPermissionPattern("http://127.0.0.1:3000")).toBe("http://127.0.0.1/*");
  });
});

describe("ownHostsOf", () => {
  test("the server origin's hostname, without port", () => {
    expect(ownHostsOf("https://omega.example.org")).toEqual(["omega.example.org"]);
    expect(ownHostsOf("http://localhost:8787")).toEqual(["localhost"]);
    expect(ownHostsOf("https://[::1]:8443")).toEqual(["[::1]"]);
  });

  test("an unparseable origin is no own hosts", () => {
    expect(ownHostsOf("not a url")).toEqual([]);
  });
});
