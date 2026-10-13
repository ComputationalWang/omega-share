import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "wxt";

// Static check on the *built* manifest.json (OME-190, threat model §10 X; store policy R1, OME-509):
// the shipped and e2e builds carry exactly this CSP and no permissions beyond ADR 0005.
const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PERMISSIONS = ["activeTab", "scripting", "storage"];
// ADR 0047 §4 (OME-1040): "Unlock with extension". Optional in Chromium, requested with the one host; Firefox can't make it
// optional, so it is install-time there (no prompt, acts only on granted hosts). The e2e builds hold it, because
// Playwright can't click the browser's permission prompt.
const DNR = "declarativeNetRequestWithHostAccess";
// Remote servers are https only (parseServerBaseUrl); cleartext only on loopback, any port.
const OPTIONAL_HOST_PERMISSIONS = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"];
const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..", "..");
const PACKAGE: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = typeof PACKAGE === "object" && PACKAGE !== null && "version" in PACKAGE ? PACKAGE.version : undefined;
const ICON_SIZES = ["16", "32", "48", "128"] as const;
const POPUP_VIGNETTES = ["cant-read.png", "cant-read@2x.png", "nothing-found.png", "nothing-found@2x.png", "server-away.png", "server-away@2x.png"];

// Firefox (OME-593, R-M7c decisions on OME-546): the permanent add-on ID, Firefox 140+ for the data-collection key,
// Firefox for Android 142+ (OME-743, the first Android release that reads it), and every category Share can send: the embed URL, which may be the page URL itself, and the room
// share token (OME-695).
const GECKO = {
  id: "omega-share@omega-share.duckdns.org",
  strict_min_version: "140.0",
  data_collection_permissions: { required: ["websiteContent", "browsingActivity", "authenticationInfo"] },
};
const GECKO_ANDROID = { strict_min_version: "142.0" };
const PRODUCTION_HOSTS = ["https://omega-share.duckdns.org/*"];
// Port-less: Firefox never matches a pattern with a port, and http://localhost/* covers the default server on :8787.
// The unlock fixture host (e2e/unlock.e2e.ts), pre-granted like a host the viewer already allowed.
const E2E_HOSTS = ["http://localhost/*", "https://www.youtube.com/*", "http://xfo.omega-fixture.net/*", "https://xfo.omega-fixture.net/*"];

const cases = [
  { name: "production", browser: "chrome", mode: "production", hostPermissions: PRODUCTION_HOSTS, permissions: PERMISSIONS },
  { name: "e2e", browser: "chrome", mode: "e2e", hostPermissions: E2E_HOSTS, permissions: [...PERMISSIONS, DNR] },
  { name: "firefox production", browser: "firefox", mode: "production", hostPermissions: PRODUCTION_HOSTS, permissions: [...PERMISSIONS, DNR] },
  { name: "firefox e2e", browser: "firefox", mode: "e2e", hostPermissions: E2E_HOSTS, permissions: [...PERMISSIONS, DNR] },
  // A run on another OMEGA_SERVER_PORT needs nothing extra: http://localhost/* covers every port (QA OME-611, OME-687).
  { name: "firefox e2e on :8987", browser: "firefox", mode: "e2e", serverPort: "8987", hostPermissions: E2E_HOSTS, permissions: [...PERMISSIONS, DNR] },
] as const;

const outRoot = mkdtempSync(join(tmpdir(), "omega-ext-manifest-"));
const manifests = new Map<string, unknown>();
const outDir = (name: string): string => join(outRoot, name, "out");

beforeAll(async () => {
  const port = process.env["OMEGA_SERVER_PORT"];
  for (const c of cases) {
    const { name, browser, mode } = c;
    if ("serverPort" in c) process.env["OMEGA_SERVER_PORT"] = c.serverPort;
    else delete process.env["OMEGA_SERVER_PORT"];
    await build({ root: ROOT, mode, browser, manifestVersion: 3, outDir: join(outRoot, name), outDirTemplate: "out" });
    manifests.set(name, JSON.parse(readFileSync(join(outDir(name), "manifest.json"), "utf8")));
  }
  if (port === undefined) delete process.env["OMEGA_SERVER_PORT"];
  else process.env["OMEGA_SERVER_PORT"] = port;
}, 180_000);

afterAll(() => {
  rmSync(outRoot, { recursive: true, force: true });
});

for (const { name: mode, browser, hostPermissions, permissions } of cases) {
  describe(`built manifest (${mode})`, () => {
    test("has exactly the extension_pages CSP", () => {
      expect(manifests.get(mode)).toHaveProperty("content_security_policy", { extension_pages: CSP });
    });

    test("asks for no new permissions, and no <all_urls> or cleartext wildcard", () => {
      expect(manifests.get(mode)).toMatchObject({
        permissions,
        host_permissions: hostPermissions,
        optional_host_permissions: OPTIONAL_HOST_PERMISSIONS,
      });
      if (browser === "firefox") expect(manifests.get(mode)).not.toHaveProperty("optional_permissions");
      else expect(manifests.get(mode)).toHaveProperty("optional_permissions", [DNR]);
      expect(JSON.stringify(manifests.get(mode))).not.toMatch(/<all_urls>|\*:\/\/\*|http:\/\/\*\//);
      // No port in any host pattern: Firefox would never match it (QA OME-687).
      expect(JSON.stringify(manifests.get(mode))).not.toMatch(/:\d+\/\*/);
    });

    test("no content scripts and a non-persistent background (a service worker in Chrome, an event page in Firefox)", () => {
      expect(manifests.get(mode)).not.toHaveProperty("content_scripts");
      // The ADR 0047 bridge is registered at runtime, on our origin only, and ships as a file.
      expect(existsSync(join(outDir(mode), "content-scripts", "bridge.js"))).toBe(true);
      expect(manifests.get(mode)).not.toHaveProperty("web_accessible_resources");
      const background = browser === "firefox" ? { scripts: ["background.js"] } : { service_worker: "background.js" };
      expect(manifests.get(mode)).toHaveProperty("background", background);
    });

    if (browser === "firefox") {
      test("carries the permanent gecko ID, Firefox 140+, all three data-collection categories and Firefox for Android 142+", () => {
        expect(manifests.get(mode)).toHaveProperty("browser_specific_settings", { gecko: GECKO, gecko_android: GECKO_ANDROID });
      });

      test("opens the options page in a tab, not inside about:addons", () => {
        expect(manifests.get(mode)).toHaveProperty("options_ui.open_in_tab", true);
      });
    } else {
      test("has no Firefox-only keys, so Chrome warns about nothing", () => {
        expect(manifests.get(mode)).not.toHaveProperty("browser_specific_settings");
        expect(manifests.get(mode)).toHaveProperty("options_ui.open_in_tab", false);
      });
    }

    test("ships the opt-in found indicator's runtime-registered script and its icons, byte for byte from assets/store (OME-1042)", () => {
      expect(existsSync(join(outDir(mode), "content-scripts", "found.js"))).toBe(true);
      for (const [file, source] of [["found-16", "found-16"], ["found-32", "found-32"], ["found-48", "found-48"], ["found-64", "found-64"], ["idle-64", "icon-64"]] as const) {
        expect(readFileSync(join(outDir(mode), "icon", `${file}.png`)).equals(readFileSync(join(REPO, "assets", "store", `${source}.png`))), file).toBe(true);
      }
    });

    test("ships the unlock consent page (ADR 0047 §5)", () => {
      expect(readFileSync(join(outDir(mode), "consent.html"), "utf8")).toContain("play in your omega-share room?");
    });

    test("takes its version from package.json", () => {
      expect(manifests.get(mode)).toHaveProperty("version", VERSION);
    });

    test("ships the store icons at 16, 32, 48 and 128 px, byte for byte from assets/store", () => {
      const icons = Object.fromEntries(ICON_SIZES.map((size) => [size, `icon/${size}.png`]));
      expect(manifests.get(mode)).toHaveProperty("icons", icons);
      expect(manifests.get(mode)).toHaveProperty("action.default_icon", icons);
      for (const size of ICON_SIZES) {
        expect(readFileSync(join(outDir(mode), "icon", `${size}.png`)).equals(readFileSync(join(REPO, "assets", "store", `icon-${size}.png`)))).toBe(true);
      }
    });

    test("ships every image the popup references, byte for byte from assets/ui/popup (OME-857)", () => {
      const html = readFileSync(join(outDir(mode), "popup.html"), "utf8");
      const refs = [...html.matchAll(/\/popup\/([\w@-]+\.png)/g)].map((m) => m[1] ?? "");
      expect([...new Set(refs)].sort()).toEqual(POPUP_VIGNETTES);
      for (const file of POPUP_VIGNETTES) {
        expect(readFileSync(join(outDir(mode), "popup", file)).equals(readFileSync(join(REPO, "assets", "ui", "popup", file))), file).toBe(true);
      }
    });
  });
}

const code = (name: string): string => {
  const dir = outDir(name);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js"));
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
};

for (const name of ["production", "firefox production"]) {
  test(`the ${name} build's code has no localhost default left in it`, () => {
    expect(code(name)).toContain("https://omega-share.duckdns.org");
    expect(code(name)).not.toContain("localhost:8787");
  });
}


// The Firefox lane's popup opener (OME-593): BiDi can't navigate to moz-extension://, so the e2e build's background
// opens popup.html?tabId= when a tab's hash asks for it. It must never reach a store build.
test("only the e2e builds carry the background's e2e popup opener", () => {
  expect(code("firefox e2e")).toContain("omega-e2e-popup");
  for (const name of ["production", "firefox production"]) expect(code(name)).not.toContain("omega-e2e-popup");
});

// It was empty until the ADR 0047 unlock (OME-1040), which parses bridge messages (valibot, the generic host rules) and
// owns the session rules. It wakes on events only and never reaches the popup's path.
test("the store builds' background stays small: the unlock only, no e2e code or its imports (OME-593, OME-1040)", () => {
  for (const name of ["production", "firefox production"]) {
    expect(readFileSync(join(outDir(name), "background.js")).byteLength, name).toBeLessThan(32 * 1024);
  }
});

test("the bridge content script stays a few KB: it runs on every page load of our own site (ADR 0047 §6)", () => {
  for (const name of ["production", "firefox production"]) {
    expect(readFileSync(join(outDir(name), "content-scripts", "bridge.js")).byteLength, name).toBeLessThan(16 * 1024);
  }
});

test("the found indicator's content script stays small: once opted in it runs on every https page (OME-1042)", () => {
  for (const name of ["production", "firefox production"]) {
    expect(readFileSync(join(outDir(name), "content-scripts", "found.js")).byteLength, name).toBeLessThan(24 * 1024);
  }
});
