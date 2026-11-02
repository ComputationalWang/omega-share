// OME-2152 (ADR 0060): pure helpers behind perf/art.perf.ts, the "Room art transfer per preset (gzipped)" row.
import { posix } from "node:path";
import * as v from "valibot";
import type { LandingResource } from "./landing";

/** One preset's art: each URL once (a second fetch of the same file is a cache hit, not new transfer), its gzipped bytes. */
export interface PresetArt {
  readonly preset: string;
  readonly files: ReadonlyMap<string, number>;
}

const ART_FILE = /\.(png|webp|avif|jpe?g|gif|svg|json)$/;

/** An art response: an image, a JSON file or an art chunk (see artChunks) from the site's own origin (the server's JSON
 *  API and the other scripts and stylesheets are not art). */
export function isArt(r: LandingResource, webOrigin: string, chunks: ReadonlySet<string> = new Set()): boolean {
  if (r.url.startsWith("data:")) return false;
  const u = new URL(r.url);
  return u.origin === webOrigin && (r.type === "image" || ART_FILE.test(u.pathname) || chunks.has(u.pathname));
}

const ManifestSchema = v.record(v.string(), v.object({ file: v.string(), src: v.optional(v.string()), isEntry: v.optional(v.boolean()) }));

/**
 * OME-2163 (ADR 0060): the lazy JS chunks that are art, as site paths ("/assets/x.js"). Vite inlines an imported JSON
 * atlas into a chunk; such a chunk is art when its modules are art files under the repo's `assets/` (at least one JSON)
 * plus at most the chunk's own loader (its manifest `src`). The manifest names the chunks and their entry module; it
 * doesn't list a chunk's modules, so `modulesOf` reads them (repo-relative, no query) from the chunk's sourcemap.
 */
export function artChunks(manifest: unknown, modulesOf: (file: string) => readonly string[]): ReadonlySet<string> {
  const chunks = new Set<string>();
  for (const c of Object.values(v.parse(ManifestSchema, manifest))) {
    if (c.isEntry === true || !c.file.endsWith(".js")) continue;
    const loader = c.src === undefined ? null : posix.join("apps/web", c.src);
    const modules = modulesOf(c.file).filter((m) => m !== loader);
    if (modules.some((m) => m.endsWith(".json")) && modules.every((m) => m.startsWith("assets/"))) chunks.add(`/${c.file}`);
  }
  return chunks;
}

/** The art among one cold load's responses, deduplicated by URL. */
export function presetArt(preset: string, resources: readonly LandingResource[], webOrigin: string, chunks: ReadonlySet<string> = new Set()): PresetArt {
  const files = new Map<string, number>();
  for (const r of resources) if (isArt(r, webOrigin, chunks)) files.set(r.url, Math.max(files.get(r.url) ?? 0, r.bytes));
  return { preset, files };
}

const total = (files: ReadonlyMap<string, number>): number => [...files.values()].reduce((a, b) => a + b, 0);
const line = (name: string, files: ReadonlyMap<string, number>): string => `${name} ${(total(files) / 1024).toFixed(1)} KB (${String(files.size)} files)`;

/** The dearest preset's KB, and the note: every preset dearest first, the union of all their files, then the art chunks. */
export function artReport(presets: readonly PresetArt[]): { readonly kb: number; readonly note: string } {
  const sorted = [...presets].sort((a, b) => total(b.files) - total(a.files));
  const dearest = sorted[0];
  if (dearest === undefined) throw new Error("no presets measured");
  const union = new Map(presets.flatMap((p) => [...p.files]));
  const js = [...union].filter(([url]) => url.endsWith(".js")).map(([url, bytes]) => `${posix.basename(new URL(url).pathname)} ${(bytes / 1024).toFixed(1)} KB`);
  const chunks = js.length > 0 ? `; art in JS chunks: ${js.join(", ")}` : "";
  return { kb: total(dearest.files) / 1024, note: `dearest ${dearest.preset}; ${sorted.map((p) => line(p.preset, p.files)).join(", ")}; ${line("union", union)}${chunks}` };
}

