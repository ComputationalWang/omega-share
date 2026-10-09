import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStoreManifest, STORE_ZIP_MAX_BYTES } from "../store/manifest";
import { buildStorePackage } from "../store/package";
import { storeZip } from "../store/zip";

const scratch = mkdtempSync(join(tmpdir(), "omega-ext-store-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Reads a zip with the system `unzip`, an independent implementation. */
const unzip = (zip: Uint8Array, ...args: string[]): string => {
  const path = join(scratch, `${String(Math.random()).slice(2)}.zip`);
  writeFileSync(path, zip);
  return execFileSync("unzip", [...args, path], { encoding: "utf8" });
};
const unzipFile = (zip: Uint8Array, name: string): string => {
  const path = join(scratch, `${String(Math.random()).slice(2)}.zip`);
  writeFileSync(path, zip);
  return execFileSync("unzip", ["-p", path, name], { encoding: "utf8" });
};

describe("storeZip", () => {
  const files = [
    { path: "popup.html", data: new TextEncoder().encode("<!doctype html><p>hi</p>".repeat(50)) },
    { path: "manifest.json", data: new TextEncoder().encode('{"manifest_version":3}') },
    { path: "icon/16.png", data: new Uint8Array([137, 80, 78, 71, 0, 255, 1, 2]) },
  ];

  test("is a valid zip that unzip reads back, entries sorted by path", () => {
    const zip = storeZip(files);
    expect(unzip(zip, "-tq")).toContain("No errors detected");
    expect(unzip(zip, "-Z1").trim().split("\n")).toEqual(["icon/16.png", "manifest.json", "popup.html"]);
    expect(unzipFile(zip, "manifest.json")).toBe('{"manifest_version":3}');
    expect(unzipFile(zip, "popup.html")).toBe("<!doctype html><p>hi</p>".repeat(50));
  });

  test("is byte-identical for the same files in any order (no timestamps, no host metadata)", () => {
    expect(Buffer.from(storeZip(files)).equals(Buffer.from(storeZip([...files].reverse())))).toBe(true);
  });

  test("compresses", () => {
    expect(storeZip(files).byteLength).toBeLessThan(files.reduce((n, f) => n + f.data.byteLength, 0));
  });
});

describe("checkStoreManifest (the packaging guard)", () => {
  const good = {
    manifest_version: 3,
    name: "omega share",
    version: "1.2.3",
    icons: { "16": "icon/16.png", "32": "icon/32.png", "48": "icon/48.png", "128": "icon/128.png" },
    permissions: ["activeTab", "scripting", "storage"],
    host_permissions: ["https://omega-share.duckdns.org/*"],
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"],
    background: { service_worker: "background.js" },
  };

  test("accepts the store manifest", () => {
    expect(checkStoreManifest(good, "1.2.3")).toEqual([]);
  });

  const bad: readonly [string, unknown, RegExp][] = [
    ["the e2e build's extra host permissions", { ...good, host_permissions: [...good.host_permissions, "http://localhost/*", "https://www.youtube.com/*"] }, /host_permissions/],
    ["a cleartext default server", { ...good, host_permissions: ["http://localhost:8787/*"] }, /host_permissions/],
    ["<all_urls>", { ...good, host_permissions: ["<all_urls>"] }, /host_permissions/],
    ["an extra permission", { ...good, permissions: [...good.permissions, "tabs"] }, /permissions/],
    ["a cleartext optional wildcard", { ...good, optional_host_permissions: ["http://*/*", "https://*/*"] }, /optional_host_permissions/],
    ["optional API permissions", { ...good, optional_permissions: ["downloads"] }, /optional_permissions/],
    ["content scripts", { ...good, content_scripts: [{ matches: ["https://*/*"], js: ["c.js"] }] }, /content_scripts/],
    ["a persistent background page", { ...good, background: { scripts: ["bg.js"], persistent: true } }, /background/],
    ["a version that isn't package.json's", { ...good, version: "0.0.1" }, /version/],
    ["missing icons", { ...good, icons: { "128": "icon/128.png" } }, /icons/],
    ["not an object", "nope", /manifest/],
  ];
  for (const [name, manifest, problem] of bad) {
    test(`rejects ${name}`, () => {
      const problems = checkStoreManifest(manifest, "1.2.3");
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join("\n")).toMatch(problem);
    });
  }
});

describe("buildStorePackage (bun run ext:store)", () => {
  const VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;

  test(
    "builds the production extension into a versioned zip ≤ 500 KB that passes the guard, byte-identical on a rebuild",
    async () => {
      const first = await buildStorePackage({ outDir: join(scratch, "a") });
      const second = await buildStorePackage({ outDir: join(scratch, "b") });
      expect(first.zipPath).toEndWith(`omega-share-${VERSION}-chrome.zip`);
      const zip = readFileSync(first.zipPath);
      expect(zip.byteLength).toBeLessThanOrEqual(STORE_ZIP_MAX_BYTES);
      expect(STORE_ZIP_MAX_BYTES).toBe(500 * 1024);
      expect(first.sha256).toBe(second.sha256);
      expect(readFileSync(second.zipPath).equals(zip)).toBe(true);

      const manifest: unknown = JSON.parse(unzipFile(zip, "manifest.json"));
      expect(checkStoreManifest(manifest, VERSION)).toEqual([]);
      expect(JSON.stringify(manifest)).not.toContain("youtube.com");
      const entries = unzip(zip, "-Z1").trim().split("\n");
      expect(entries).toContain("icon/128.png");
      expect(entries).toContain("popup.html");
      expect(entries.some((e) => e.endsWith(".map"))).toBe(false);
    },
    120_000,
  );
});
