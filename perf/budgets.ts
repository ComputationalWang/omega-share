// Budgets from docs/perf-budgets.md. budgets.test.ts fails if these drift from the doc.

export type Comparator = "<=" | "<";

export interface Budget {
  readonly id: string;
  readonly area: string;
  readonly metric: string;
  /** Exact text of the Metric column in docs/perf-budgets.md. */
  readonly docMetric: string;
  readonly unit: "KB" | "MB" | "ms" | "%" | "count";
  readonly limit: number;
  readonly comparator: Comparator;
  /** Load-test row: budget `of`, held with `members` people in the room (the doc's "People in a room" cell). */
  readonly load?: { readonly of: string; readonly members: number };
}

const LOAD_DOC = "People in a room without breaking the budgets above";

/** Frame-spec providers, in `site.frameWorkP95.<provider>` / `site.missedVsync.<provider>` ids. YouTube's frame p95 is plain `site.frameP95`. */
export const FRAME_PROVIDERS = ["youtube", "twitchVod", "twitchLive", "vimeo"] as const;
export type FrameProvider = (typeof FRAME_PROVIDERS)[number];

const PROVIDER_LABEL: Record<FrameProvider, string> = { youtube: "YouTube", twitchVod: "Twitch VOD", twitchLive: "Twitch live", vimeo: "Vimeo" };

// ADR 0017 (OME-185/OME-192): the headroom a quantised rAF p95 can't show — observer main-thread work, and missed vsyncs as their own row.
const HEADROOM: readonly Budget[] = FRAME_PROVIDERS.flatMap((p): Budget[] => [
  { id: `site.frameWorkP95.${p}`, area: "Site", metric: `Main-thread work p95 per frame, 8 avatars + ${PROVIDER_LABEL[p]}`, docMetric: "Main-thread work per frame, 8 avatars + video playing", unit: "ms", limit: 8, comparator: "<=" },
  { id: `site.missedVsync.${p}`, area: "Site", metric: `Missed vsyncs, 8 avatars + ${PROVIDER_LABEL[p]}`, docMetric: "Missed vsyncs, 8 avatars + video playing", unit: "%", limit: 1, comparator: "<=" },
]);

export const BUDGETS: readonly Budget[] = [
  { id: "site.initialJsGzip", area: "Site", metric: "Initial JS (gzipped)", docMetric: "Initial JS (gzipped)", unit: "KB", limit: 200, comparator: "<=" },
  { id: "site.tti", area: "Site", metric: "Time to interactive, localhost", docMetric: "Time to interactive, localhost", unit: "ms", limit: 1500, comparator: "<" },
  { id: "site.frameP95", area: "Site", metric: "p95 frame time, 8 avatars + video", docMetric: "Frame rate, 8 avatars + video playing", unit: "ms", limit: 16.7, comparator: "<=" },
  { id: "site.frameP95.vimeo", area: "Site", metric: "p95 frame time, 8 avatars + Vimeo video", docMetric: "Frame rate, 8 avatars + video playing", unit: "ms", limit: 16.7, comparator: "<=" },
  { id: "site.frameP95.twitchVod", area: "Site", metric: "p95 frame time, 8 avatars + Twitch VOD", docMetric: "Frame rate, 8 avatars + video playing", unit: "ms", limit: 16.7, comparator: "<=" },
  { id: "site.frameP95.twitchLive", area: "Site", metric: "p95 frame time, 8 avatars + Twitch live", docMetric: "Frame rate, 8 avatars + video playing", unit: "ms", limit: 16.7, comparator: "<=" },
  ...HEADROOM,
  { id: "site.heapAfterSoak", area: "Site", metric: "JS heap after 10 min soak (after GC)", docMetric: "JS heap after 10 min in room", unit: "MB", limit: 150, comparator: "<=" },
  { id: "sync.spread", area: "Sync", metric: "Spread after play/pause/seek", docMetric: "Spread between clients after play/pause/seek", unit: "ms", limit: 500, comparator: "<=" },
  // M2 (OME-131): one merge-blocking row per provider. Twitch live has no position: its spread is first-to-last client applying a pause / play-from-live.
  { id: "sync.spread.twitchVod", area: "Sync", metric: "Spread after play/pause/seek, Twitch VOD", docMetric: "Spread between clients after play/pause/seek", unit: "ms", limit: 500, comparator: "<=" },
  { id: "sync.spread.twitchLive", area: "Sync", metric: "Spread after pause/play-from-live, Twitch live", docMetric: "Spread between clients after play/pause/seek", unit: "ms", limit: 500, comparator: "<=" },
  { id: "sync.spread.vimeo", area: "Sync", metric: "Spread after play/pause/seek, Vimeo (seek-only)", docMetric: "Spread between clients after play/pause/seek", unit: "ms", limit: 500, comparator: "<=" },
  { id: "server.relayLatency", area: "Server", metric: "Relay latency, control action", docMetric: "Relay latency for a control action, localhost", unit: "ms", limit: 50, comparator: "<=" },
  // Threat model §8 Q (OME-192): 24 members at the allowed chat/control rates + 1 socket flooding chat at 10× L1.
  { id: "server.relayLatencyFlood", area: "Server", metric: "Relay latency, control action, under flood", docMetric: "Relay latency for a control action under flood, localhost", unit: "ms", limit: 50, comparator: "<=" },
  { id: "ext.popupToList", area: "Extension", metric: "Popup opened → embeds listed", docMetric: "Popup opened → embeds listed", unit: "ms", limit: 300, comparator: "<=" },
  { id: "ext.contentScripts", area: "Extension", metric: "Declared content scripts", docMetric: "Content scripts on page load", unit: "count", limit: 0, comparator: "<=" },
  { id: "ext.persistentBackground", area: "Extension", metric: "Persistent background violations", docMetric: "Persistent background", unit: "count", limit: 0, comparator: "<=" },
  { id: "load.relayLatency", area: "Load test", metric: "Relay latency p95, 25 in room + traffic", docMetric: LOAD_DOC, unit: "ms", limit: 50, comparator: "<=", load: { of: "server.relayLatency", members: 25 } },
  { id: "load.frameP95", area: "Load test", metric: "p95 frame time, 25 in room + traffic", docMetric: LOAD_DOC, unit: "ms", limit: 16.7, comparator: "<=", load: { of: "site.frameP95", members: 25 } },
];

export type Measurement =
  | { readonly id: string; readonly value: number; readonly note?: string }
  | { readonly id: string; readonly pending: string };

export type Status = "pass" | "fail" | "pending";

export interface Result {
  readonly budget: Budget;
  readonly status: Status;
  readonly value?: number;
  readonly note?: string;
}

export function evaluate(budget: Budget, m: Measurement | undefined): Result {
  if (m === undefined) return { budget, status: "pending", note: "not measured" };
  if ("pending" in m) return { budget, status: "pending", note: m.pending };
  const ok = budget.comparator === "<=" ? m.value <= budget.limit : m.value < budget.limit;
  const base = { budget, status: ok ? "pass" : "fail", value: m.value } as const;
  return m.note === undefined ? base : { ...base, note: m.note };
}

const fmt = (n: number, unit: Budget["unit"]): string =>
  unit === "count" ? String(n) : `${n.toFixed(1)} ${unit}`;

const LABEL: Record<Status, string> = { pass: "✅ PASS", fail: "❌ FAIL", pending: "⏳ PENDING" };

export function renderReport(results: readonly Result[]): string {
  const rows = results.map((r) => {
    const measured = r.value === undefined ? "—" : fmt(r.value, r.budget.unit);
    const budget = `${r.budget.comparator === "<=" ? "≤" : "<"} ${fmt(r.budget.limit, r.budget.unit)}`;
    return `| ${LABEL[r.status]} | ${r.budget.area} | ${r.budget.metric} | ${measured} | ${budget} | ${r.note ?? ""} |`;
  });
  const count = (s: Status): number => results.filter((r) => r.status === s).length;
  return [
    "# Perf budget report",
    "",
    "| Status | Area | Metric | Measured | Budget | Notes |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `**${String(count("pass"))} passed, ${String(count("fail"))} failed, ${String(count("pending"))} pending.**`,
    "",
  ].join("\n");
}
