import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DB_PATH, parseConfig } from "../src/config";

const dist = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omega-dist-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  return dir;
};

describe("parseConfig (ADR 0015 §3)", () => {
  test("defaults to local dev: loopback bind, port 8787, Vite site origin, no proxy trust, no static site", () => {
    expect(parseConfig({})).toEqual({
      port: 8787,
      hostname: "127.0.0.1",
      siteOrigin: "http://localhost:5173",
      publicOrigin: null,
      trustProxy: false,
      staticDir: null,
      extensionIds: null,
      dbPath: DEFAULT_DB_PATH,
      genericEmbeds: true,
      genericEmbedDenylist: [],
      ownHosts: ["localhost"],
      roomTitleBlocklist: [],
      metricsPort: null,
      maxConnections: 1024,
    });
  });

  test("reads tunnel mode", () => {
    const staticDir = dist();
    const cfg = parseConfig({
      PORT: "9000",
      HOST: "::1",
      PUBLIC_ORIGIN: "https://quiet-otter.ngrok-free.app",
      TRUST_PROXY: "loopback",
      STATIC_DIR: staticDir,
      EXTENSION_IDS: "abcdefghijklmnopabcdefghijklmnop, ponmlkjihgfedcbaponmlkjihgfedcba",
    });
    expect(cfg).toEqual({
      port: 9000,
      hostname: "::1",
      siteOrigin: "http://localhost:5173",
      publicOrigin: "https://quiet-otter.ngrok-free.app",
      trustProxy: true,
      staticDir,
      extensionIds: ["abcdefghijklmnopabcdefghijklmnop", "ponmlkjihgfedcbaponmlkjihgfedcba"],
      dbPath: DEFAULT_DB_PATH,
      genericEmbeds: true,
      genericEmbedDenylist: [],
      ownHosts: ["localhost", "quiet-otter.ngrok-free.app"],
      roomTitleBlocklist: [],
      metricsPort: null,
      maxConnections: 1024,
    });
  });

  test("normalizes a public origin's case and a trailing slash", () => {
    expect(parseConfig({ PUBLIC_ORIGIN: "https://Quiet-Otter.ngrok-free.app/" }).publicOrigin).toBe(
      "https://quiet-otter.ngrok-free.app",
    );
  });

  test("TRUST_PROXY=off is the same as unset", () => {
    expect(parseConfig({ TRUST_PROXY: "off" }).trustProxy).toBe(false);
  });

  test.each([
    ["PORT", "80000"],
    ["PORT", "eighty"],
    ["PUBLIC_ORIGIN", "http://quiet-otter.ngrok-free.app"],
    ["PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app/room"],
    ["PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app?x=1"],
    ["PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app?"],
    ["PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app#"],
    ["SITE_ORIGIN", "http://localhost:5173?"],
    ["PUBLIC_ORIGIN", "https://user:pw@quiet-otter.ngrok-free.app"],
    ["PUBLIC_ORIGIN", "not a url"],
    ["SITE_ORIGIN", "http://example.com"],
    ["SITE_ORIGIN", "http://localhost:5173/app"],
    ["TRUST_PROXY", "true"],
    ["TRUST_PROXY", "all"],
    ["STATIC_DIR", "/nonexistent/omega-dist"],
    ["EXTENSION_IDS", "not-an-id"],
    ["HOST", ""],
    ["DB_PATH", ""],
  ])("refuses %s=%p", (key, value) => {
    expect(() => parseConfig({ [key]: value })).toThrow(key);
  });

  test("a static dir without index.html is refused", () => {
    expect(() => parseConfig({ STATIC_DIR: mkdtempSync(join(tmpdir(), "omega-empty-")) })).toThrow("STATIC_DIR");
  });

  test("an http site origin is fine on loopback; https anywhere", () => {
    for (const o of ["http://127.0.0.1:5173", "http://[::1]:5173", "https://omega.example"]) {
      expect(parseConfig({ SITE_ORIGIN: o }).siteOrigin).toBe(o);
    }
  });
});

describe("generic embeds (ADR 0024 §5, §6)", () => {
  test("GENERIC_EMBEDS is on unless set to off; any other value fails startup", () => {
    expect(parseConfig({ GENERIC_EMBEDS: "on" }).genericEmbeds).toBe(true);
    expect(parseConfig({ GENERIC_EMBEDS: "off" }).genericEmbeds).toBe(false);
    for (const bad of ["", "true", "1", "OFF", "yes"]) {
      expect(() => parseConfig({ GENERIC_EMBEDS: bad })).toThrow(/GENERIC_EMBEDS/);
    }
  });

  test("GENERIC_EMBED_DENYLIST is comma-separated domains, normalised; empty means none", () => {
    expect(parseConfig({ GENERIC_EMBED_DENYLIST: "" }).genericEmbedDenylist).toEqual([]);
    expect(parseConfig({ GENERIC_EMBED_DENYLIST: " Bad.Video.net. , evil.tv" }).genericEmbedDenylist).toEqual([
      "bad.video.net",
      "evil.tv",
    ]);
  });

  test.each(["evil.tv/path", "evil.tv:443", "user@evil.tv", "evil.tv,,", "https://evil.tv"])(
    "a denylist entry that is not a bare hostname fails startup: %p",
    (raw) => {
      expect(() => parseConfig({ GENERIC_EMBED_DENYLIST: raw })).toThrow(/GENERIC_EMBED_DENYLIST/);
    },
  );

  test("own hosts: localhost, the site's host and the public host, normalised; IP literals are left out", () => {
    expect(parseConfig({ SITE_ORIGIN: "https://Watch.Example.org", PUBLIC_ORIGIN: "https://quiet-otter.ngrok-free.app" }).ownHosts).toEqual([
      "localhost",
      "watch.example.org",
      "quiet-otter.ngrok-free.app",
    ]);
    // An IP literal can never be a generic embed's host, so it needs no own-host entry.
    expect(parseConfig({ SITE_ORIGIN: "http://127.0.0.1:5173" }).ownHosts).toEqual(["localhost"]);
    expect(parseConfig({ SITE_ORIGIN: "http://[::1]:5173" }).ownHosts).toEqual(["localhost"]);
  });
});

describe("ROOM_TITLE_BLOCKLIST (ADR 0028, research S8)", () => {
  test("comma-separated terms, trimmed, empty ones dropped; unset or empty means none", () => {
    expect(parseConfig({}).roomTitleBlocklist).toEqual([]);
    expect(parseConfig({ ROOM_TITLE_BLOCKLIST: "" }).roomTitleBlocklist).toEqual([]);
    expect(parseConfig({ ROOM_TITLE_BLOCKLIST: " spam , Scam,," }).roomTitleBlocklist).toEqual(["spam", "Scam"]);
  });
});

describe("DB_PATH (research D5)", () => {
  test("defaults to apps/server/data/omega.db, outside any static dir", () => {
    expect(DEFAULT_DB_PATH).toBe(join(import.meta.dir, "../data/omega.db"));
  });

  test("takes :memory: as is, and resolves a relative path", () => {
    expect(parseConfig({ DB_PATH: ":memory:" }).dbPath).toBe(":memory:");
    expect(parseConfig({ DB_PATH: "omega.db" }).dbPath).toBe(join(process.cwd(), "omega.db"));
  });

  test("refuses a DB_PATH inside STATIC_DIR, however it is spelled", () => {
    const staticDir = dist();
    for (const p of [join(staticDir, "omega.db"), join(staticDir, "assets", "omega.db"), `${staticDir}/./x/../omega.db`]) {
      expect(() => parseConfig({ STATIC_DIR: staticDir, DB_PATH: p })).toThrow("DB_PATH");
    }
  });

  test("refuses a DB_PATH reached through a symlink into STATIC_DIR", () => {
    const staticDir = dist();
    const link = join(mkdtempSync(join(tmpdir(), "omega-link-")), "site");
    symlinkSync(staticDir, link);
    expect(() => parseConfig({ STATIC_DIR: staticDir, DB_PATH: join(link, "omega.db") })).toThrow("DB_PATH");
  });

  test("a sibling directory that only shares the prefix is fine", () => {
    const staticDir = dist();
    const p = `${staticDir}-data/omega.db`;
    expect(parseConfig({ STATIC_DIR: staticDir, DB_PATH: p }).dbPath).toBe(p);
  });
});

describe("METRICS_PORT (OME-504)", () => {
  test("off or unset means no metrics listener; a port number turns it on", () => {
    expect(parseConfig({}).metricsPort).toBeNull();
    expect(parseConfig({ METRICS_PORT: "off" }).metricsPort).toBeNull();
    expect(parseConfig({ METRICS_PORT: "9464" }).metricsPort).toBe(9464);
  });

  test("anything else, or the app's own port, fails startup", () => {
    for (const bad of ["", "abc", "70000", "-1"]) expect(() => parseConfig({ METRICS_PORT: bad })).toThrow("METRICS_PORT");
    expect(() => parseConfig({ PORT: "9000", METRICS_PORT: "9000" })).toThrow("METRICS_PORT");
  });
});

describe("MAX_CONNECTIONS (OME-573)", () => {
  test("unset allows 1024 open sockets: the M6 target of 500 with headroom", () => {
    expect(parseConfig({}).maxConnections).toBe(1024);
  });

  test("an integer from 1 to 3072 sets the global socket cap", () => {
    expect(parseConfig({ MAX_CONNECTIONS: "1" }).maxConnections).toBe(1);
    expect(parseConfig({ MAX_CONNECTIONS: "600" }).maxConnections).toBe(600);
    expect(parseConfig({ MAX_CONNECTIONS: "3072" }).maxConnections).toBe(3072);
  });

  test("anything else fails startup: the cap must leave descriptors for HTTP and SQLite under LimitNOFILE=4096", () => {
    for (const bad of ["", "0", "-1", "1.5", "abc", "1e3", "3073", "99999999"])
      expect(() => parseConfig({ MAX_CONNECTIONS: bad })).toThrow("MAX_CONNECTIONS");
  });
});

describe("index.ts", () => {
  test("a bad PUBLIC_ORIGIN exits non-zero before listening", () => {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/index.ts")], {
      env: { ...process.env, PORT: "0", PUBLIC_ORIGIN: "http://plain.example" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("PUBLIC_ORIGIN");
    expect(r.stdout.toString()).not.toContain("server on");
  });
});
