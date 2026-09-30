import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";

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
