import type { Server } from "bun";
import { CLOSE_CODES, REPORT_ERROR_CODES, REPORT_REASONS, REPORT_STATUSES, type ReportReason } from "@omega/shared";

/**
 * Server metrics (OME-504), Prometheus text on a loopback-only port that Caddy never proxies.
 * Only counts, sizes and durations: no label or value ever names an address, nickname, room or title.
 */

/** Relay time buckets, seconds: a frame in → fanned out, on the server (docs/perf-budgets.md: ≤ 50 ms end to end). */
const RELAY_BUCKETS = [0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05] as const;

/** Close codes the server sends itself; Bun's own 1006 closes (backpressure, oversize) never reach a handler. */
export const SERVICE_RESTART = 1012;
const COUNTED_CLOSES = [
  CLOSE_CODES.JOIN_TIMEOUT,
  CLOSE_CODES.ROOM_FULL,
  CLOSE_CODES.ROOM_CLOSED,
  CLOSE_CODES.RATE_LIMITED,
  CLOSE_CODES.BAD_MESSAGES,
  CLOSE_CODES.KICKED,
  CLOSE_CODES.TAKEN_DOWN,
  SERVICE_RESTART,
] as const;
export type CountedClose = (typeof COUNTED_CLOSES)[number];

/** How a `POST /rooms/:id/report` ended (ADR 0033 §3): its answer's status or error code. */
export const REPORT_OUTCOMES = [...REPORT_STATUSES, ...REPORT_ERROR_CODES] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

/** What the live server knows right now, read at scrape time. */
export interface Gauges {
  rooms: number;
  sockets: number;
  members: number;
  /** Open abuse reports. */
  openReports: number;
}

export class Metrics {
  /** Per bucket (not cumulative) plus +Inf last; cumulated at render. No allocation per observation. */
  private readonly relayCounts = new Float64Array(RELAY_BUCKETS.length + 1);
  private relaySum = 0;
  private relayCount = 0;
  private readonly closes = new Map<CountedClose, number>(COUNTED_CLOSES.map((c) => [c, 0]));
  private readonly reports = new Map<ReportOutcome, number>(REPORT_OUTCOMES.map((o) => [o, 0]));
  private readonly reasons = new Map<ReportReason, number>(REPORT_REASONS.map((r) => [r, 0]));
  private takedowns = 0;

  /** One relayed frame took `ms` on the server. */
  observeRelay(ms: number): void {
    const s = ms / 1000;
    let i = 0;
    while (i < RELAY_BUCKETS.length && s > (RELAY_BUCKETS[i] ?? Infinity)) i++;
    this.relayCounts[i] = (this.relayCounts[i] ?? 0) + 1;
    this.relaySum += s;
    this.relayCount++;
  }

  countClose(code: CountedClose): void {
    this.closes.set(code, (this.closes.get(code) ?? 0) + 1);
  }

  /** One report answered; `reason` only for a stored one. Never a room, key or note. */
  countReport(outcome: ReportOutcome, reason?: ReportReason): void {
    this.reports.set(outcome, (this.reports.get(outcome) ?? 0) + 1);
    if (reason !== undefined) this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
  }

  countTakedown(): void {
    this.takedowns++;
  }

  render(g: Gauges): string {
    const out: string[] = [];
    const gauge = (name: string, help: string, value: number): void => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${String(value)}`);
    };
    gauge("omega_rooms", "Live rooms.", g.rooms);
    gauge("omega_sockets", "Open WebSockets, joined or not.", g.sockets);
    gauge("omega_members", "Joined members, all rooms.", g.members);

    const relay = "omega_relay_latency_seconds";
    out.push(`# HELP ${relay} Server time from a frame's arrival to its fan-out.`, `# TYPE ${relay} histogram`);
    let cumulative = 0;
    RELAY_BUCKETS.forEach((le, i) => {
      cumulative += this.relayCounts[i] ?? 0;
      out.push(`${relay}_bucket{le="${String(le)}"} ${String(cumulative)}`);
    });
    out.push(`${relay}_bucket{le="+Inf"} ${String(this.relayCount)}`, `${relay}_sum ${String(this.relaySum)}`, `${relay}_count ${String(this.relayCount)}`);

    const closes = "omega_ws_closes_total";
    out.push(`# HELP ${closes} WebSocket closes the server sent, by close code.`, `# TYPE ${closes} counter`);
    for (const [code, n] of this.closes) out.push(`${closes}{code="${String(code)}"} ${String(n)}`);

    const counter = (name: string, help: string, label: string, values: ReadonlyMap<string, number>): void => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const [k, n] of values) out.push(`${name}{${label}="${k}"} ${String(n)}`);
    };
    counter("omega_reports_total", "Abuse reports answered, by outcome.", "outcome", this.reports);
    counter("omega_reports_received_total", "Abuse reports stored, by reason.", "reason", this.reasons);
    gauge("omega_reports_open", "Open abuse reports.", g.openReports);
    out.push("# HELP omega_takedowns_total Rooms taken down by the operator.", "# TYPE omega_takedowns_total counter", `omega_takedowns_total ${String(this.takedowns)}`);

    gauge("process_resident_memory_bytes", "Resident set size.", process.memoryUsage.rss());
    gauge("process_uptime_seconds", "Seconds since the process started.", process.uptime());
    return `${out.join("\n")}\n`;
  }
}

/**
 * `GET /metrics` on 127.0.0.1:`port`, nothing else. The bind address is not configurable; the Host check
 * refuses DNS rebinding from a browser on the box, like the app's own (ADR 0015 §4).
 */
export function startMetrics(opts: { port: number; render: () => string }): Server<undefined> {
  const hosts = new Set<string>();
  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    maxRequestBodySize: 1024,
    fetch(req) {
      if (!hosts.has(req.headers.get("host")?.toLowerCase() ?? "")) return new Response("misdirected request\n", { status: 421 });
      if (new URL(req.url).pathname !== "/metrics") return new Response("not found\n", { status: 404 });
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
      return new Response(opts.render(), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
      });
    },
  });
  for (const name of ["127.0.0.1", "localhost"]) hosts.add(`${name}:${String(server.port)}`);
  return server;
}
