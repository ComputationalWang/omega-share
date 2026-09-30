import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "wxt";

// Static check on the *built* manifest.json (OME-190, threat model §10 X): the shipped and e2e builds
// carry exactly this CSP and no permissions beyond ADR 0005.
const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PERMISSIONS = ["activeTab", "scripting", "storage"];
const OPTIONAL_HOST_PERMISSIONS = ["http://*/*", "https://*/*"];

const cases = [
  { mode: "production", hostPermissions: ["http://localhost:8787/*"] },
  { mode: "e2e", hostPermissions: ["http://localhost:8787/*", "http://localhost/*", "https://www.youtube.com/*"] },
] as const;

const outRoot = mkdtempSync(join(tmpdir(), "omega-ext-manifest-"));
const manifests = new Map<string, unknown>();

beforeAll(async () => {
  for (const { mode } of cases) {
    const outDir = join(outRoot, mode);
    await build({ root: join(import.meta.dir, ".."), mode, outDir, outDirTemplate: "chrome-mv3" });
    manifests.set(mode, JSON.parse(readFileSync(join(outDir, "chrome-mv3", "manifest.json"), "utf8")));
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

    test("asks for no new permissions", () => {
      expect(manifests.get(mode)).toMatchObject({
        permissions: PERMISSIONS,
        host_permissions: hostPermissions,
        optional_host_permissions: OPTIONAL_HOST_PERMISSIONS,
      });
      expect(manifests.get(mode)).not.toHaveProperty("optional_permissions");
    });
  });
}

