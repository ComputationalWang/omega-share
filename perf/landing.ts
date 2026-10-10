// OME-763: pure helpers behind perf/landing.perf.ts (the "Landing" budgets in docs/perf-budgets.md).
import { gzipSync } from "node:zlib";

/** One response the landing page fetched: Playwright's resource type and its body gzipped. */
export interface LandingResource {
  readonly url: string;
  readonly type: string;
  readonly bytes: number;
}

export interface LandingTransfer {
  readonly kb: number;
  readonly counted: readonly LandingResource[];
  readonly api: readonly LandingResource[];
}

// API calls carry data, not the page; websockets and event streams aren't page weight either.
const API_TYPES = new Set(["fetch", "xhr"]);
const NOT_TRANSFER = new Set(["websocket", "eventsource"]);

/** Body size gzipped at zlib level 6 (the zlib default, and what the hosted Caddy serves). */
export function gzipBytes(body: Uint8Array): number {
  return gzipSync(body, { level: 6 }).byteLength;
}

/** Total gzipped transfer of the static responses: data: URLs live inside their parent's bytes, API calls are listed apart. */
export function landingTransfer(resources: readonly LandingResource[]): LandingTransfer {
  const real = resources.filter((r) => !r.url.startsWith("data:") && !NOT_TRANSFER.has(r.type));
  const counted = real.filter((r) => !API_TYPES.has(r.type));
  const api = real.filter((r) => API_TYPES.has(r.type));
  return { kb: counted.reduce((sum, r) => sum + r.bytes, 0) / 1024, counted, api };
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
const name = (url: string): string => {
  const u = new URL(url);
  const last = u.pathname.split("/").pop() ?? "";
  return last === "" ? u.pathname : last;
};

/** Report note: per-type totals, the scripts by name (a warmed room/Pixi chunk shows up here), and the uncounted API calls. */
export function transferNote(t: LandingTransfer): string {
  const byType = new Map<string, number>();
  for (const r of t.counted) byType.set(r.type, (byType.get(r.type) ?? 0) + r.bytes);
  const types = [...byType].sort((a, b) => b[1] - a[1]).map(([type, bytes]) => `${type} ${kb(bytes)}`);
  const scripts = t.counted.filter((r) => r.type === "script").map((r) => name(r.url));
  const parts = [`${String(t.counted.length)} files: ${types.join(", ")}`, `scripts: ${scripts.length > 0 ? scripts.join(", ") : "none"}`];
  if (t.api.length > 0) parts.push(`not counted (API): ${t.api.map((r) => `${new URL(r.url).pathname} ${kb(r.bytes)}`).join(", ")}`);
  return parts.join("; ");
}

/** Sum of the layout shifts not caused by input (no session windowing, so never below the web-vitals CLS). */
export function cumulativeLayoutShift(shifts: readonly { value: number; hadRecentInput: boolean }[]): number {
  return shifts.filter((s) => !s.hadRecentInput).reduce((sum, s) => sum + s.value, 0);
}

/** The longest long task that started before `usableAt` (ms since navigation start); 0 if none did. */
export function longestTaskBefore(tasks: readonly { startTime: number; duration: number }[], usableAt: number): number {
  return tasks.filter((t) => t.startTime < usableAt).reduce((max, t) => Math.max(max, t.duration), 0);
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error("no samples");
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? Number.NaN) : ((s[mid - 1] ?? Number.NaN) + (s[mid] ?? Number.NaN)) / 2;
}
