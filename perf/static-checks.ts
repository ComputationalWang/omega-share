import { gzipSync } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ManifestCheck {
  readonly contentScripts: number;
  readonly persistentBackground: readonly string[];
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Checks the built MV3 manifest: no declared content scripts, event-driven service worker only. */
export function checkManifest(manifest: unknown): ManifestCheck {
  if (!isRecord(manifest)) throw new Error("manifest.json is not an object");
  const cs = manifest["content_scripts"];
  const contentScripts = Array.isArray(cs) ? cs.length : 0;
  const violations: string[] = [];
  if (manifest["manifest_version"] !== 3) violations.push("manifest_version is not 3");
  const bg = manifest["background"];
  if (isRecord(bg)) {
    if (bg["persistent"] === true) violations.push("background.persistent is true");
    if ("page" in bg) violations.push("background.page is set");
    if ("scripts" in bg) violations.push("background.scripts is set");
  }
  return { contentScripts, persistentBackground: violations };
}

export interface BundleSize {
  readonly kb: number;
  readonly files: readonly string[];
}

/** Gzipped size of JS loaded by index.html up front: entry scripts + modulepreloads. Dynamic chunks are excluded. */
export function initialJsGzipKb(distDir: string): BundleSize {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const refs = [
    ...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g),
    ...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g),
  ]
    .map((m) => m[1] ?? "")
    .filter((src) => src !== "" && !/^(?:[a-z]+:)?\/\//i.test(src))
    .map((src) => src.replace(/^\.?\//, ""));
  const files = [...new Set(refs)];
  const bytes = files.reduce((sum, f) => sum + gzipSync(readFileSync(join(distDir, f))).byteLength, 0);
  return { kb: bytes / 1024, files };
}
