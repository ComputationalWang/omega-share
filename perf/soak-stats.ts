/** The soak's pure parts: statistics, stderr tally, the pass criteria and the arguments. Runner: perf/server-soak.ts. */
import { percentile } from "./server-load";

const HOUR = 3_600_000;

export interface Sample {
  tMs: number;
  rss: number;
  fds: number;
  threads: number;
  wal: number;
}
export interface WindowStat {
  startMs: number;
  count: number;
  p50: number;
  p95: number;
  p99: number;
}
export interface RestartResult {
  exitCode: number | null;
  exitMs: number;
  stderr: string;
  seatsExpected: number;
  seatsRestored: number;
}
export interface SoakResult {
  durationMs: number;
  /** One array of samples per server process, in order. */
  segments: Sample[][];
  windows: WindowStat[];
  /** Every graceful stop: the planned restarts and the final one. */
  restarts: RestartResult[];
  plannedRestarts: number;
  unplannedExits: number;
  unexpectedCloses: number;
  /** `bad_message` answers to the soak's own regular clients: a harness bug, not a server finding. */
  badMessages: number;
  /** Error-level stderr events outside the expected list, by event. */
  errors: Record<string, number>;
  integrity: string;
  consistency: { name: string; client: number; server: number }[];
  abuse: { kind: string; started: number; cut: number }[];
}
export interface Check {
  name: string;
  ok: boolean;
  enforced: boolean;
  detail: string;
}

/** Slope bounds over a long run (per hour), the p99 budget (docs/perf-budgets.md) and the planned restart's limits (ADR 0032). */
export const BOUNDS = { rssBytesPerHour: 1 << 20, fdsPerHour: 1, threadsPerHour: 0.5, walBytesPerHour: 256 << 10 };
export const P99_BUDGET_MS = 50;
/** A window with fewer probes than this has no meaningful p99; it is reported, not judged. */
export const MIN_WINDOW_SAMPLES = 10;
export const RESTART_EXIT_LIMIT_MS = 10_000;
/** Slopes are only enforced for runs at least this long: a short run is dominated by allocator warm-up. */
export const SLOPE_MIN_RUN_MS = 2 * HOUR;
export const SOCKET_LIMIT = 500;
/**
 * Error-level stderr events the abusive clients are expected to cause. None: the server answers floods, oversize
 * frames, stalled readers and slow bodies with closes and counters, never an error line, so any error line is a finding.
 */
export const EXPECTED_ERROR_EVENTS: readonly string[] = [];

/**
 * Pooled least-squares slope per hour: every segment (one server process) keeps its own intercept, so the drop at a
 * restart is not a trend. Fewer than two points, or no time spread, gives 0.
 */
export function slopePerHour(segments: { tMs: number; v: number }[][]): number {
  let sxx = 0;
  let sxy = 0;
  for (const seg of segments) {
    if (seg.length < 2) continue;
    const mt = seg.reduce((a, p) => a + p.tMs, 0) / seg.length;
    const mv = seg.reduce((a, p) => a + p.v, 0) / seg.length;
    for (const p of seg) {
      sxx += (p.tMs - mt) ** 2;
      sxy += (p.tMs - mt) * (p.v - mv);
    }
  }
  return sxx === 0 ? 0 : (sxy / sxx) * HOUR;
}

/** Probe latencies grouped into fixed windows by the time the probe started. */
export function windowPercentiles(lat: { tMs: number; ms: number }[], windowMs: number): WindowStat[] {
  const by = new Map<number, number[]>();
  for (const { tMs, ms } of lat) {
    const k = Math.floor(tMs / windowMs) * windowMs;
    const xs = by.get(k);
    if (xs === undefined) by.set(k, [ms]);
    else xs.push(ms);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startMs, xs]) => {
      xs.sort((a, b) => a - b);
      return { startMs, count: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), p99: percentile(xs, 99) };
    });
}

/** Prometheus text → `name` or `name{labels}` → value. */
export function parseMetrics(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const at = line.lastIndexOf(" ");
    const n = Number(line.slice(at + 1));
    if (at > 0 && Number.isFinite(n)) out.set(line.slice(0, at), n);
  }
  return out;
}

/** Counts stderr lines by `level:event` (a line that is not a JSON log line counts as `raw:`). */
export class StderrTally {
  counts: Record<string, number> = {};
  total = 0;
  #partial = "";
  add(chunk: string): void {
    const lines = (this.#partial + chunk).split("\n");
    this.#partial = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") continue;
      let key = "raw:";
      try {
        const j: unknown = JSON.parse(line);
        if (typeof j === "object" && j !== null && "level" in j && "event" in j) key = `${String(j.level)}:${String(j.event)}`;
      } catch {
        // not JSON: raw
      }
      this.counts[key] = (this.counts[key] ?? 0) + 1;
      this.total++;
    }
  }
  /** Error-level events not in `expected`, by event. */
  unexpectedErrors(expected: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, n] of Object.entries(this.counts)) {
      if (!key.startsWith("error:")) continue;
      const event = key.slice(6);
      if (!expected.includes(event)) out[event] = n;
    }
    return out;
  }
}

/** Segments' samples with each segment's warm-up dropped: the first min(30 min, 20 %) of its span. */
function settled(segments: Sample[][]): Sample[][] {
  return segments.map((seg) => {
    const first = seg[0]?.tMs ?? 0;
    const span = (seg[seg.length - 1]?.tMs ?? 0) - first;
    const warm = Math.min(30 * 60_000, span * 0.2);
    return seg.filter((s) => s.tMs - first >= warm);
  });
}

export function evaluate(r: SoakResult): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, enforced = true): void => {
    checks.push({ name, ok, enforced, detail });
  };
  add("no unplanned exits", r.unplannedExits === 0, `${String(r.unplannedExits)} unplanned exits or crashes`);
  const errs = Object.entries(r.errors);
  add("no unexpected error lines", errs.length === 0, errs.length === 0 ? "none" : errs.map(([e, n]) => `${e} x${String(n)}`).join(", "));

  const seg = settled(r.segments);
  const slope = (name: string, key: "rss" | "fds" | "threads" | "wal", bound: number): void => {
    const v = slopePerHour(seg.map((s) => s.map((x) => ({ tMs: x.tMs, v: x[key] }))));
    add(name, v < bound, `${v.toFixed(2)} per hour (bound ${String(bound)})`, r.durationMs >= SLOPE_MIN_RUN_MS);
  };
  slope("rss slope", "rss", BOUNDS.rssBytesPerHour);
  slope("fd slope", "fds", BOUNDS.fdsPerHour);
  slope("thread slope", "threads", BOUNDS.threadsPerHour);
  slope("wal slope", "wal", BOUNDS.walBytesPerHour);

  const judged = r.windows.filter((w) => w.count >= MIN_WINDOW_SAMPLES);
  const worst = judged.reduce((m, w) => Math.max(m, w.p99), 0);
  add(
    "p99 per window",
    judged.length > 0 && worst <= P99_BUDGET_MS,
    judged.length === 0 ? "no window had enough probes" : `worst window p99 ${worst.toFixed(1)} ms (budget ${String(P99_BUDGET_MS)})`,
  );

  const badRestarts = r.restarts.flatMap((x, i) => {
    const why: string[] = [];
    if (x.exitCode !== 0) why.push(`exit ${String(x.exitCode)}`);
    if (x.exitMs > RESTART_EXIT_LIMIT_MS) why.push(`took ${String(x.exitMs)} ms`);
    if (x.stderr !== "") why.push("stderr not empty");
    if (x.seatsRestored !== x.seatsExpected) why.push(`seats ${String(x.seatsRestored)}/${String(x.seatsExpected)}`);
    return why.length === 0 ? [] : [`#${String(i + 1)}: ${why.join(", ")}`];
  });
  if (r.restarts.length !== r.plannedRestarts) badRestarts.push(`${String(r.restarts.length)} of ${String(r.plannedRestarts)} planned restarts ran`);
  add(
    "planned restarts",
    badRestarts.length === 0,
    badRestarts.length === 0 ? `${String(r.restarts.length)} ok (exit 0 within ${String(RESTART_EXIT_LIMIT_MS)} ms, empty stderr, seats restored)` : badRestarts.join("; "),
  );

  add("integrity_check", r.integrity === "ok", r.integrity);
  const off = r.consistency.filter((c) => c.client !== c.server);
  add(
    "metrics consistency",
    off.length === 0,
    off.length === 0 ? `${String(r.consistency.length)} counters agree` : off.map((c) => `${c.name}: client ${String(c.client)}, server ${String(c.server)}`).join("; "),
  );
  const abuse = (list: SoakResult["abuse"]): string => list.map((a) => `${a.kind} ${String(a.cut)}/${String(a.started)}`).join(", ");
  const notCut = r.abuse.filter((a) => a.cut !== a.started);
  add("abusive clients cut", notCut.length === 0, notCut.length === 0 ? abuse(r.abuse) || "none ran" : abuse(notCut));
  add("client frames well-formed", r.badMessages === 0, `${String(r.badMessages)} bad_message answers to the soak's own clients (a harness bug if not 0)`);
  add("unexpected closes", r.unexpectedCloses === 0, `${String(r.unexpectedCloses)} sockets closed that the soak did not expect`);
  return checks;
}

export interface SoakArgs {
  server: string;
  label: string;
  minutes: number;
  restartEveryMin: number;
  sampleS: number;
  windowS: number;
  rooms: number;
  members: number;
  out: string;
  allowErrors: string[];
}

function numIn(name: string, raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw === undefined ? def : Number(raw);
  if (!(n >= min && n <= max)) throw new Error(`${name} must be a number from ${String(min)} to ${String(max)}`);
  return n;
}

export function parseSoakArgs(argv: string[]): SoakArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) flags.set(a.slice(2), argv[++i] ?? "");
  }
  const server = flags.get("server");
  if (server === undefined || server === "") throw new Error('--server "<command>" is required');
  const minutes = numIn("--minutes", flags.get("minutes"), 24 * 60, 0.1, 7 * 24 * 60);
  const rooms = numIn("--rooms", flags.get("rooms"), 8, 2, 100);
  const members = numIn("--members", flags.get("members"), 22, 5, 25);
  // Headroom for the room churn and the abusive clients on top of the steady members.
  if (rooms * members + 50 > SOCKET_LIMIT) throw new Error(`--rooms × --members + 50 must stay within ${String(SOCKET_LIMIT)} sockets`);
  return {
    server,
    label: flags.get("label") ?? server,
    minutes,
    restartEveryMin: numIn("--restart-every-min", flags.get("restart-every-min"), Math.min(180, minutes / 3), 0, 7 * 24 * 60),
    sampleS: numIn("--sample-s", flags.get("sample-s"), 10, 0.5, 600),
    windowS: numIn("--window-s", flags.get("window-s"), 60, 1, 3600),
    rooms,
    members,
    out: flags.get("out") ?? "soak-out",
    allowErrors: (flags.get("allow-errors") ?? "").split(",").filter((e) => e !== ""),
  };
}
