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
const VERSION: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const ICON_SIZES = [16, 32, 48, 128] as const;

const cases = [
  { mode: "production", hostPermissions: ["https://omega-share.duckdns.org/*"] },
  { mode: "e2e", hostPermissions: ["http://localhost:8787/*", "http://localhost/*", "https://www.youtube.com/*"] },
] as const;

const outRoot = mkdtempSync(join(tmpdir(), "omega-ext-manifest-"));
const manifests = new Map<string, unknown>();
const outDir = (mode: string): string => join(outRoot, mode, "chrome-mv3");

beforeAll(async () => {
  for (const { mode } of cases) {
    await build({ root: ROOT, mode, outDir: join(outRoot, mode), outDirTemplate: "chrome-mv3" });
    manifests.set(mode, JSON.parse(readFileSync(join(outDir(mode), "manifest.json"), "utf8")));
  }
}, 60_000);

afterAll(() => {
  rmSync(outRoot, { recursive: true, force: true });
});

for (const { mode, hostPermissions } of cases) {
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

    test("no content scripts and a non-persistent service worker", () => {
      expect(manifests.get(mode)).not.toHaveProperty("content_scripts");
      expect(manifests.get(mode)).toHaveProperty("background", { service_worker: "background.js" });
    });

    test("takes its version from package.json", () => {
      expect(manifests.get(mode)).toHaveProperty("version", VERSION);
    });

    test("ships the store icons at 16, 32, 48 and 128 px, byte for byte from assets/store", () => {
      const icons = Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icon/${size}.png`]));
      expect(manifests.get(mode)).toHaveProperty("icons", icons);
      expect(manifests.get(mode)).toHaveProperty("action.default_icon", icons);
      for (const size of ICON_SIZES) {
        expect(readFileSync(join(outDir(mode), "icon", `${size}.png`)).equals(readFileSync(join(REPO, "assets", "store", `icon-${size}.png`)))).toBe(true);
      }
    });
  });
}

test("the production build's code has no localhost default left in it", () => {
  const dir = outDir("production");
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.(js|html)$/.test(f));
  const code = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  expect(code).toContain("https://omega-share.duckdns.org");
  expect(code).not.toContain("localhost:8787");
});
