import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintProblems, webExtLint } from "../store/lint";
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
    ["Firefox-only keys", { ...good, browser_specific_settings: { gecko: { id: "omega-share@omega-share.duckdns.org" } } }, /browser_specific_settings/],
  ];
  for (const [name, manifest, problem] of bad) {
    test(`rejects ${name}`, () => {
      const problems = checkStoreManifest(manifest, "1.2.3");
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join("\n")).toMatch(problem);
    });
  }
});

describe("checkStoreManifest for Firefox (OME-593)", () => {
  const gecko = {
    id: "omega-share@omega-share.duckdns.org",
    strict_min_version: "140.0",
    data_collection_permissions: { required: ["websiteContent", "browsingActivity"] },
  };
  const chromeKeys = {
    manifest_version: 3,
    name: "omega share",
    version: "1.2.3",
    icons: { "16": "icon/16.png", "32": "icon/32.png", "48": "icon/48.png", "128": "icon/128.png" },
    permissions: ["activeTab", "scripting", "storage"],
    host_permissions: ["https://omega-share.duckdns.org/*"],
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"],
  };
  const good = { ...chromeKeys, background: { scripts: ["background.js"] }, options_ui: { page: "options.html", open_in_tab: true }, browser_specific_settings: { gecko } };

  test("accepts the Firefox store manifest", () => {
    expect(checkStoreManifest(good, "1.2.3", "firefox")).toEqual([]);
  });

  test("the Chrome guard still rejects it, and the Firefox guard rejects the Chrome manifest", () => {
    expect(checkStoreManifest(good, "1.2.3")).not.toEqual([]);
    expect(checkStoreManifest({ ...chromeKeys, background: { service_worker: "background.js" } }, "1.2.3", "firefox")).not.toEqual([]);
  });

  const bad: readonly [string, unknown, RegExp][] = [
    ["a service worker (Firefox has none)", { ...good, background: { service_worker: "background.js" } }, /background/],
    ["a persistent background page", { ...good, background: { scripts: ["background.js"], persistent: true } }, /background/],
    ["no gecko ID", { ...good, browser_specific_settings: { gecko: { ...gecko, id: undefined } } }, /gecko\.id/],
    ["another gecko ID (it is permanent)", { ...good, browser_specific_settings: { gecko: { ...gecko, id: "omega@example.com" } } }, /gecko\.id/],
    ["no strict_min_version", { ...good, browser_specific_settings: { gecko: { ...gecko, strict_min_version: undefined } } }, /strict_min_version/],
    ["an older strict_min_version", { ...good, browser_specific_settings: { gecko: { ...gecko, strict_min_version: "128.0" } } }, /strict_min_version/],
    ["no data_collection_permissions", { ...good, browser_specific_settings: { gecko: { ...gecko, data_collection_permissions: undefined } } }, /data_collection_permissions/],
    ["data collection declared as none", { ...good, browser_specific_settings: { gecko: { ...gecko, data_collection_permissions: { required: ["none"] } } } }, /data_collection_permissions/],
    ["only websiteContent", { ...good, browser_specific_settings: { gecko: { ...gecko, data_collection_permissions: { required: ["websiteContent"] } } } }, /data_collection_permissions/],
    ["optional data collection", { ...good, browser_specific_settings: { gecko: { ...gecko, data_collection_permissions: { required: gecko.data_collection_permissions.required, optional: ["technicalAndInteraction"] } } } }, /data_collection_permissions/],
    ["an Android listing", { ...good, browser_specific_settings: { gecko, gecko_android: { strict_min_version: "142.0" } } }, /gecko_android/],
    ["options inside about:addons", { ...good, options_ui: { page: "options.html", open_in_tab: false } }, /open_in_tab/],
    ["the e2e build's extra host permissions", { ...good, host_permissions: [...good.host_permissions, "http://localhost/*"] }, /host_permissions/],
    ["an extra permission", { ...good, permissions: [...good.permissions, "tabs"] }, /permissions/],
    ["content scripts", { ...good, content_scripts: [{ matches: ["https://*/*"], js: ["c.js"] }] }, /content_scripts/],
  ];
  for (const [name, manifest, problem] of bad) {
    test(`rejects ${name}`, () => {
      const problems = checkStoreManifest(manifest, "1.2.3", "firefox");
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

describe("buildStorePackage for Firefox (OME-593)", () => {
  const VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;

  test(
    "builds omega-share-<version>-firefox.zip ≤ 500 KB that passes the Firefox guard and web-ext lint (0 errors; the one warning is the desktop-only Android note), byte-identical on a rebuild",
    async () => {
      const first = await buildStorePackage({ outDir: join(scratch, "fa"), browser: "firefox" });
      const second = await buildStorePackage({ outDir: join(scratch, "fb"), browser: "firefox" });
      expect(first.zipPath).toEndWith(`omega-share-${VERSION}-firefox.zip`);
      const zip = readFileSync(first.zipPath);
      expect(zip.byteLength).toBeLessThanOrEqual(STORE_ZIP_MAX_BYTES);
      expect(first.sha256).toBe(second.sha256);

      const manifest: unknown = JSON.parse(unzipFile(zip, "manifest.json"));
      expect(checkStoreManifest(manifest, VERSION, "firefox")).toEqual([]);
      expect(JSON.stringify(manifest)).not.toContain("youtube.com");

      const dir = join(scratch, "firefox-unzipped");
      unzip(zip, "-q", "-d", dir);
      const lint = await webExtLint(dir);
      expect(lint.errors).toEqual([]);
      // Desktop only (CEO decision, OME-546): no gecko_android key, so the linter notes that Firefox for Android 140
      // would not read data_collection_permissions. Adding gecko_android would list the add-on on Android.
      expect(lint.warnings.map((w) => w.split(" ")[0])).toEqual(["KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION"]);
      expect(lintProblems(lint)).toEqual([]);
    },
    180_000,
  );
});

describe("lintProblems (what fails ext:store)", () => {
  const android = "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION manifest.json: Manifest key not supported by the specified minimum Firefox for Android version";
  test("lets only the desktop-only Android warning through", () => {
    expect(lintProblems({ errors: [], warnings: [android] })).toEqual([]);
  });
  test("fails on any error, and on any other warning", () => {
    expect(lintProblems({ errors: ["ADDON_ID_REQUIRED manifest.json: x"], warnings: [] })).toEqual(["ADDON_ID_REQUIRED manifest.json: x"]);
    expect(lintProblems({ errors: [], warnings: [android, "UNSAFE_VAR_ASSIGNMENT popup.js: x"] })).toEqual(["UNSAFE_VAR_ASSIGNMENT popup.js: x"]);
    expect(lintProblems({ errors: [android], warnings: [] })).toEqual([android]);
  });
});

describe("webExtLint", () => {
  test("reports the error and warning a Firefox MV3 manifest without gecko keys gets", async () => {
    const dir = join(scratch, "lint-bad");
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0", background: { scripts: ["bg.js"] } }));
    writeFileSync(join(dir, "bg.js"), "");
    const result = await webExtLint(dir);
    expect(result.errors.join("\n")).toContain("ADDON_ID_REQUIRED");
    expect(result.warnings.join("\n")).toContain("MISSING_DATA_COLLECTION_PERMISSIONS");
  }, 60_000);
});
