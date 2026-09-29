// Which app pieces exist yet. Specs `test.fixme` on these until the piece lands, so `bun run e2e` stays green.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const ROOT = join(import.meta.dirname, "../..");

export const PORTS = {
  fixtures: Number(process.env["OMEGA_FIXTURE_PORT"] ?? 4400),
  web: Number(process.env["OMEGA_WEB_PORT"] ?? 5173),
  server: Number(process.env["OMEGA_SERVER_PORT"] ?? 8787),
} as const;

export const URLS = {
  fixtures: `http://localhost:${String(PORTS.fixtures)}`,
  web: process.env["OMEGA_WEB_URL"] ?? `http://localhost:${String(PORTS.web)}`,
  server: process.env["OMEGA_SERVER_URL"] ?? `http://localhost:${String(PORTS.server)}`,
} as const;

/**
 * Unpacked build Playwright loads: the shipped code plus host permissions, because Playwright can't grant
 * `activeTab` (ADR 0005). Override with OMEGA_EXTENSION_DIR.
 */
export const EXTENSION_DIR = process.env["OMEGA_EXTENSION_DIR"] ?? join(ROOT, "apps/extension/.output/chrome-mv3-e2e");
/** The build we ship. Static manifest checks (`bun run perf`) run against this one. */
export const EXTENSION_SHIPPED_DIR = join(ROOT, "apps/extension/.output/chrome-mv3");
export const WEB_DIST_DIR = join(ROOT, "apps/web/dist");

export function scripts(app: "web" | "server" | "extension"): Record<string, string> {
  const pkg: unknown = JSON.parse(readFileSync(join(ROOT, "apps", app, "package.json"), "utf8"));
  if (typeof pkg !== "object" || pkg === null || !("scripts" in pkg)) return {};
  const s = pkg.scripts;
  if (typeof s !== "object" || s === null) return {};
  return Object.fromEntries(Object.entries(s).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export const available = {
  web: "dev" in scripts("web"),
  server: "dev" in scripts("server"),
  extension: existsSync(join(EXTENSION_DIR, "manifest.json")),
} as const;

export const PENDING = {
  web: "apps/web has no `dev` script yet (OME-6)",
  server: "apps/server has no `dev` script yet (OME-5)",
  extension: `extension not built at ${relative(ROOT, EXTENSION_DIR) || "."} — run \`bun run --filter @omega/extension build\` (OME-7)`,
} as const;
