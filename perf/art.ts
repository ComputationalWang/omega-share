// OME-2152 (ADR 0060): pure helpers behind perf/art.perf.ts, the "Room art transfer per preset (gzipped)" row.
import type { LandingResource } from "./landing";

/** One preset's art: each URL once (a second fetch of the same file is a cache hit, not new transfer), its gzipped bytes. */
export interface PresetArt {
  readonly preset: string;
  readonly files: ReadonlyMap<string, number>;
}

const ART_FILE = /\.(png|webp|avif|jpe?g|gif|svg|json)$/;

/** An art response: an image or a JSON file from the site's own origin (the server's JSON API, scripts and stylesheets are not art). */
export function isArt(r: LandingResource, webOrigin: string): boolean {
  if (r.url.startsWith("data:")) return false;
  const u = new URL(r.url);
  return u.origin === webOrigin && (r.type === "image" || ART_FILE.test(u.pathname));
}

/** The art among one cold load's responses, deduplicated by URL. */
export function presetArt(preset: string, resources: readonly LandingResource[], webOrigin: string): PresetArt {
  const files = new Map<string, number>();
  for (const r of resources) if (isArt(r, webOrigin)) files.set(r.url, Math.max(files.get(r.url) ?? 0, r.bytes));
  return { preset, files };
}

const total = (files: ReadonlyMap<string, number>): number => [...files.values()].reduce((a, b) => a + b, 0);
const line = (name: string, files: ReadonlyMap<string, number>): string => `${name} ${(total(files) / 1024).toFixed(1)} KB (${String(files.size)} files)`;

/** The dearest preset's KB, and the note: every preset dearest first, then the union of all their files. */
export function artReport(presets: readonly PresetArt[]): { readonly kb: number; readonly note: string } {
  const sorted = [...presets].sort((a, b) => total(b.files) - total(a.files));
  const dearest = sorted[0];
  if (dearest === undefined) throw new Error("no presets measured");
  const union = new Map(presets.flatMap((p) => [...p.files]));
  return { kb: total(dearest.files) / 1024, note: `dearest ${dearest.preset}; ${sorted.map((p) => line(p.preset, p.files)).join(", ")}; ${line("union", union)}` };
}
