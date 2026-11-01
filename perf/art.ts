// OME-2152 (ADR 0060): pure helpers behind perf/art.perf.ts, the "Room art transfer per preset (gzipped)" row.
import type { LandingResource } from "./landing";

/** One preset's art: each URL once (a second fetch of the same file is a cache hit, not new transfer), its gzipped bytes. */
export interface PresetArt {
  readonly preset: string;
  readonly files: ReadonlyMap<string, number>;
}

/** An art response: an image or a JSON file from the site's own origin (the server's JSON API, scripts and stylesheets are not art). */
export function isArt(_r: LandingResource, _webOrigin: string): boolean {
  throw new Error("todo");
}

/** The art among one cold load's responses, deduplicated by URL. */
export function presetArt(_preset: string, _resources: readonly LandingResource[], _webOrigin: string): PresetArt {
  throw new Error("todo");
}

/** The dearest preset's KB, and the note: every preset dearest first, then the union of all their files. */
export function artReport(_presets: readonly PresetArt[]): { readonly kb: number; readonly note: string } {
  throw new Error("todo");
}
