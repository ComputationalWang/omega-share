import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "wxt";

// Static check on the *built* manifest.json (OME-190, threat model §10 X; store policy R1, OME-509):
// the shipped and e2e builds carry exactly this CSP and no permissions beyond ADR 0005.
const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PERMISSIONS = ["activeTab", "scripting", "storage"];
// Remote servers are https only (parseServerBaseUrl); cleartext only on loopback, any port.
const OPTIONAL_HOST_PERMISSIONS = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"];
const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..", "..");
const PACKAGE: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = typeof PACKAGE === "object" && PACKAGE !== null && "version" in PACKAGE ? PACKAGE.version : undefined;
const ICON_SIZES = ["16", "32", "48", "128"] as const;

// Firefox (OME-593, R-M7c decisions on OME-546): the permanent add-on ID, Firefox 140+ for the data-collection key,
// desktop only, and both categories Share can send (the embed URL, which may be the page URL itself).
const GECKO = {
  id: "omega-share@omega-share.duckdns.org",
  strict_min_version: "140.0",
  data_collection_permissions: { required: ["websiteContent", "browsingActivity"] },
};
const PRODUCTION_HOSTS = ["https://omega-share.duckdns.org/*"];
const E2E_HOSTS = ["http://localhost:8787/*", "http://localhost/*", "https://www.youtube.com/*"];

const cases = [
  { name: "production", browser: "chrome", mode: "production", hostPermissions: PRODUCTION_HOSTS },
  { name: "e2e", browser: "chrome", mode: "e2e", hostPermissions: E2E_HOSTS },
  { name: "firefox production", browser: "firefox", mode: "production", hostPermissions: PRODUCTION_HOSTS },
  { name: "firefox e2e", browser: "firefox", mode: "e2e", hostPermissions: E2E_HOSTS },
] as const;

const outRoot = mkdtempSync(join(tmpdir(), "omega-ext-manifest-"));
const manifests = new Map<string, unknown>();
const outDir = (name: string): string => join(outRoot, name, "out");

beforeAll(async () => {
  for (const { name, browser, mode } of cases) {
    await build({ root: ROOT, mode, browser, manifestVersion: 3, outDir: join(outRoot, name), outDirTemplate: "out" });
    manifests.set(name, JSON.parse(readFileSync(join(outDir(name), "manifest.json"), "utf8")));
  }
}, 120_000);

afterAll(() => {
  rmSync(outRoot, { recursive: true, force: true });
});

for (const { name: mode, browser, hostPermissions } of cases) {
  describe(`built manifest (${mode})`, () => {
    test("has exactly the extension_pages CSP", () => {
      expect(manifests.get(mode)).toHaveProperty("content_security_policy", { extension_pages: CSP });
    });

    test("asks for no new permissions, and no <all_urls> or cleartext wildcard", () => {
      expect(manifests.get(mode)).toMatchObject({
        permissions: PERMISSIONS,
        host_permissions: hostPermissions,
        optional_host_permissions: OPTIONAL_HOST_PERMISSIONS,
      });
      expect(manifests.get(mode)).not.toHaveProperty("optional_permissions");
      expect(JSON.stringify(manifests.get(mode))).not.toMatch(/<all_urls>|\*:\/\/\*|http:\/\/\*\//);
    });

    test("no content scripts and a non-persistent background (a service worker in Chrome, an event page in Firefox)", () => {
      expect(manifests.get(mode)).not.toHaveProperty("content_scripts");
      const background = browser === "firefox" ? { scripts: ["background.js"] } : { service_worker: "background.js" };
      expect(manifests.get(mode)).toHaveProperty("background", background);
    });

    if (browser === "firefox") {
      test("carries the permanent gecko ID, Firefox 140+, both data-collection categories and nothing for Android", () => {
        expect(manifests.get(mode)).toHaveProperty("browser_specific_settings", { gecko: GECKO });
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
