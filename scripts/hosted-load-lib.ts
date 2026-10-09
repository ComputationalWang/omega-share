/**
 * Pure helpers for `scripts/hosted-load.ts` (OME-511): reading the box's `/metrics` scrape and
 * `/proc/<pid>/stat`, and the numbers the load test reports.
 */

/** Series (name plus labels, as written) → value. Comments, blanks and malformed lines are skipped. */
export function parsePrometheus(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const space = line.lastIndexOf(" ");
    if (space <= 0) continue;
    const value = Number(line.slice(space + 1));
    if (!Number.isFinite(value)) continue;
    out.set(line.slice(0, space), value);
  }
  return out;
}

const RELAY = "omega_relay_latency_seconds";

/** Cumulative relay histogram from one scrape: finite upper bounds ascending, then the total count. */
export interface RelayHistogram {
  bounds: number[];
  cumulative: number[];
  count: number;
  sum: number;
}

export function relayHistogram(series: Map<string, number>): RelayHistogram {
  const finite: [number, number][] = [];
  const prefix = `${RELAY}_bucket{le="`;
  for (const [key, value] of series) {
    if (!key.startsWith(prefix)) continue;
    const le = key.slice(prefix.length, -2);
    if (le !== "+Inf") finite.push([Number(le), value]);
  }
  finite.sort((a, b) => a[0] - b[0]);
  return {
    bounds: finite.map(([le]) => le),
    cumulative: finite.map(([, c]) => c),
    count: series.get(`${RELAY}_count`) ?? 0,
    sum: series.get(`${RELAY}_sum`) ?? 0,
  };
}

/**
 * Quantile `q` of the observations made between two scrapes, interpolated linearly inside its bucket
 * (as Prometheus' histogram_quantile does). Infinity when it lies past the top finite bucket, null when
 * the window is empty. A smaller count after than before means the process restarted: the second
 * scrape is taken on its own.
 */
export function histogramQuantile(before: RelayHistogram, after: RelayHistogram, q: number): number | null {
  const reset = after.count < before.count;
  const base = (i: number): number => (reset ? 0 : (before.cumulative[i] ?? 0));
  const total = after.count - (reset ? 0 : before.count);
  if (total <= 0) return null;
  const rank = q * total;
  let prevCum = 0;
  let prevBound = 0;
  for (let i = 0; i < after.bounds.length; i++) {
    const cum = (after.cumulative[i] ?? 0) - base(i);
    const bound = after.bounds[i] ?? 0;
    if (cum >= rank) {
      const inBucket = cum - prevCum;
      return inBucket <= 0 ? bound : prevBound + ((rank - prevCum) / inBucket) * (bound - prevBound);
    }
    prevCum = cum;
    prevBound = bound;
  }
  return Infinity;
}

/** CPU ticks (utime + stime) and RSS pages from a `/proc/<pid>/stat` line. */
export function parseProcStat(line: string): { ticks: number; rssPages: number } | null {
  const close = line.lastIndexOf(")");
  if (close < 0) return null;
  // Field 3 (state) onwards; utime is field 14, stime 15, rss 24.
  const f = line.slice(close + 1).trim().split(/\s+/);
  const utime = Number(f[11]);
  const stime = Number(f[12]);
  const rss = Number(f[21]);
  if (![utime, stime, rss].every(Number.isFinite)) return null;
  return { ticks: utime + stime, rssPages: rss };
}

/** Percent of one core used between two samples (`at` in seconds), or null for no elapsed time. */
export function cpuPercent(a: { ticks: number; at: number }, b: { ticks: number; at: number }, clkTck: number): number | null {
  const wall = b.at - a.at;
  if (wall <= 0) return null;
  return ((b.ticks - a.ticks) / clkTck / wall) * 100;
}

/**
 * The `X-Forwarded-For` address a simulated client sends through the ssh tunnel: 198.18.0.0/15
 * (RFC 2544, benchmarking), one per room and client, so each simulated person has their own
 * rate-limit key on the server, as real people do.
 */
export function simulatedAddress(room: number, client: number): string {
  if (!Number.isInteger(room) || room < 0 || room > 511) throw new Error(`room ${String(room)} out of range`);
  if (!Number.isInteger(client) || client < 0 || client > 253) throw new Error(`client ${String(client)} out of range`);
  return `198.${String(18 + Math.floor(room / 256))}.${String(room % 256)}.${String(client + 1)}`;
}

/** Each non-empty needle that occurs in `text` (case-insensitive), with its count. */
export function findPersonalData(text: string, needles: readonly string[]): { needle: string; count: number }[] {
  const hay = text.toLowerCase();
  const hits: { needle: string; count: number }[] = [];
  for (const needle of needles) {
    if (needle === "") continue;
    const n = needle.toLowerCase();
    let count = 0;
    for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + n.length)) count++;
    if (count > 0) hits.push({ needle, count });
  }
  return hits;
}

/** Nearest-rank percentile (q in 0..1) of a copy of `values`; null when empty. */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null;
}
