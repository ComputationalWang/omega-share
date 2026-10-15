/**
 * Builds classification.md: every apps/server/test test, its category and the slice that owns making
 * it pass against the Rust binary. Usage: `bun run blackbox --dump=dump.json`, then
 * `bun apps/server-rs/blackbox/classify.ts dump.json > apps/server-rs/blackbox/classification.md`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseJunit, type TestResult } from "./report";

export type Category = "A" | "A*" | "B" | "C" | "D" | "E" | "skipped";

export interface Evidence {
  status: "pass" | "fail" | "not-black-box" | "skip";
  /** Passes with a binary that cannot start: it never touches a server. */
  serverFree: boolean;
  /** The failure message (the `NotBlackBox` reason for a refused option). */
  reason: string;
  /** The test's own source, for fixtures and spies. */
  source: string;
  /** The file holds shell-script tests: not server code. */
  notServer: boolean;
}

const OPTION = /^(\w+)[:.]/;
const B_OPTIONS = new Set(["now", "wallNow", "schedule", "statusIntervalMs", "joinTimeoutMs", "roomGcIntervalMs"]);
const A_STAR = /^(maxConnectionsPerIp|maxHttpInFlight|server\.(metricsText|drain))\b/;
const CLOCK_IN_SOURCE = /TestClock|fakeClock|fakeTime|clocks\(\)/;
const DB_IN_SOURCE = /openDatabase|DB_PATH|new Database/;
const SPY_IN_SOURCE = /spyOn|calls\.push|mock\(/;

export function categorize(e: Evidence): Category {
  if (e.notServer) return "E";
  if (e.status === "skip") return "skipped";
  if (e.status === "pass" && e.serverFree) return "D";
  if (e.status === "not-black-box") {
    const option = OPTION.exec(e.reason)?.[1] ?? "";
    if (B_OPTIONS.has(option)) return "B";
    if (A_STAR.test(e.reason)) return "A*";
    if (option === "store" || option === "reportStore") {
      return DB_IN_SOURCE.test(e.source) && !SPY_IN_SOURCE.test(e.source) ? "C" : "D";
    }
    // registry, rooms, ownHosts, seatHolds, spies and the other server internals: a Rust unit test.
    return "D";
  }
  if (e.status === "pass") return "A";
  if (CLOCK_IN_SOURCE.test(e.source)) return "B";
  if (DB_IN_SOURCE.test(e.source)) return "C";
  return "A";
}

/** Who makes a file's tests pass against the binary (S5 HTTP, S6 WebSocket, S7 ops; the rest are ported). */
export const OWNER: Record<string, string> = {
  "abuse.test.ts": "S6",
  "backup.test.ts": "S7",
  "boundary.test.ts": "S5",
  "cli.test.ts": "S7",
  "config.test.ts": "S1 (ported: config.rs)",
  "deploy-kit.test.ts": "none (shell)",
  "durable-sessions.test.ts": "S6",
  "emote.test.ts": "S6",
  "fuzz.test.ts": "S6",
  "generic-embeds.test.ts": "S5",
  "graceful-restart.test.ts": "S7",
  "http-limits.test.ts": "S5",
  "log.test.ts": "S1 (ported: log.rs)",
  "member-status.test.ts": "S6",
  "metrics.test.ts": "S7",
  "moderation.test.ts": "S6",
  "monitor.test.ts": "none (shell)",
  "persistence.test.ts": "S7",
  "playback-sync.test.ts": "S6",
  "playback.test.ts": "S4c (room core)",
  "providers.test.ts": "S5",
  "proxy.test.ts": "S5",
  "qa-rooms.test.ts": "S5",
  "queue.test.ts": "S6",
  "rate-limit.test.ts": "S5",
  "relay-latency.test.ts": "S6",
  "report-store.test.ts": "S3 (ported: store/reports.rs)",
  "reports.test.ts": "S5",
  "room-auth.test.ts": "S6",
  "room-create.test.ts": "S5",
  "room-lifecycle.test.ts": "S6",
  "room-owner.test.ts": "S6",
  "rooms-gc.test.ts": "S7",
  "server.test.ts": "S5",
  "session-contract-compat.test.ts": "S6",
  "share-token.test.ts": "S5",
  "site.test.ts": "S5",
  "store.test.ts": "S3 (ported: store/rooms.rs)",
  "takedown.test.ts": "S7",
  "tunnel-script.test.ts": "none (shell)",
  "ws-limits.test.ts": "S6",
};

const SHELL = ["deploy-kit.test.ts", "monitor.test.ts", "tunnel-script.test.ts"];
const CATEGORIES = ["A", "A*", "B", "C", "D", "E", "skipped"];
const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

function report(dumpPath: string): string {
  const root = resolve(import.meta.dir, "../../..");
  const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as { results: TestResult[]; serverFree: string[] };
  const results = [...dump.results];
  const serverFree = new Set(dump.serverFree);
  // The shell-script files aren't run against the binary; list their tests from one in-process run.
  const scratch = mkdtempSync(join(tmpdir(), "omega-classify-"));
  const junit = join(scratch, "junit.xml");
  Bun.spawnSync(
    ["bun", "test", ...SHELL.map((f) => `apps/server/test/${f}`), "--reporter=junit", `--reporter-outfile=${junit}`],
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  );
  results.push(...parseJunit(readFileSync(junit, "utf8")));
  rmSync(scratch, { recursive: true, force: true });
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "manifest.json"), "utf8")) as { tests: string[]; timing?: string[] };
  const listed = new Set(manifest.tests);
  // Latency budgets and limiter refills measured against the real clock: they only mean something in process.
  const timing = new Set(manifest.timing ?? []);

  const sources = new Map<string, string[]>();
  const linesOf = (file: string): string[] => {
    const cached = sources.get(file);
    if (cached !== undefined) return cached;
    const lines = readFileSync(resolve(root, file), "utf8").split("\n");
    sources.set(file, lines);
    return lines;
  };
  const byFile = new Map<string, TestResult[]>();
  for (const r of results) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);

  const tally: Record<string, Record<string, number>> = {};
  const sections: string[] = [];
  for (const file of [...byFile.keys()].sort()) {
    const tests = (byFile.get(file) ?? []).sort((a, b) => a.line - b.line);
    const name = basename(file);
    const owner = OWNER[name] ?? "?";
    const rows: string[] = [];
    const counts: Record<string, number> = {};
    tests.forEach((t, i) => {
      const next = tests[i + 1]?.line ?? t.line + 60;
      const source = linesOf(file)
        .slice(Math.max(t.line - 1, 0), Math.max(next - 1, t.line))
        .join("\n");
      const category = categorize({
        status: t.status,
        serverFree: serverFree.has(t.id),
        reason: t.reason,
        source,
        notServer: SHELL.includes(name),
      });
      counts[category] = (counts[category] ?? 0) + 1;
      const own = (tally[owner] ??= {});
      own[category] = (own[category] ?? 0) + 1;
      const title = t.id.split("::").slice(1).join(" › ").replaceAll("|", "\\|");
      const label = timing.has(t.id) ? `${category} (timing: in-process only)` : category;
      rows.push(`| ${String(t.line)} | ${label}${listed.has(t.id) ? " ✓" : ""} | ${title} |`);
    });
    const summary = Object.entries(counts)
      .sort()
      .map(([c, n]) => `${c} ${String(n)}`)
      .join(", ");
    sections.push(
      `### ${name}\n\nOwner: ${owner}. ${String(tests.length)} tests: ${summary}.\n\n| line | cat | test |\n|---|---|---|\n${rows.join("\n")}\n`,
    );
  }

  const table = Object.keys(tally)
    .sort()
    .map((o) => {
      const row = tally[o] ?? {};
      return `| ${o} | ${CATEGORIES.map((c) => String(row[c] ?? 0)).join(" | ")} | ${String(sum(row))} |`;
    })
    .join("\n");
  const all: Record<string, number> = {};
  for (const o of Object.values(tally)) for (const [c, n] of Object.entries(o)) all[c] = (all[c] ?? 0) + n;
  const totals = `| **all** | ${CATEGORIES.map((c) => `**${String(all[c] ?? 0)}**`).join(" | ")} | **${String(sum(all))}** |`;

  return `# Black-box classification (OME-1165)

Generated by \`bun apps/server-rs/blackbox/classify.ts <dump>\` from one \`bun run blackbox --dump=<dump>\` run against the binary built with \`test-hooks\`.
Do not edit by hand: re-run it after a slice moves tests into the manifest (a ✓ marks tests already in \`manifest.json\`).

| cat | meaning | what to do |
|---|---|---|
| A | talks to a server with options that map to environment variables | passes as soon as the owning slice lands the route or message it exercises |
| A* | as A, but needs a knob the binary doesn't have yet (\`maxConnectionsPerIp\`, \`maxHttpInFlight\`, the metrics text, \`drain\`) | the owning slice adds the env var, reads the metrics port or sends SIGTERM, then edits the test's \`start()\` options |
| B | needs virtual time: a fake \`now\`/\`wallNow\`/\`schedule\` or a shortened interval | change \`fakeClock()\` to \`new TestClock()\` and \`clock.ms += x\` to \`await clock.set({ mono: … })\` (see emote.test.ts); the binary's \`/__test/time\` does the rest |
| C | seeds or inspects a SQLite file | open the same file the binary got as \`DB_PATH\` (WAL, readable while it runs); \`envFor\` already maps \`dbPath\` |
| D | white-box (registry, spies, injected stores, pure units, server internals) | a Rust unit test in the slice that ports the module; the TS test stays as the in-process reference |
| E | shell scripts (deploy kit, monitor, tunnel): not server code | nothing; not run against the binary |

Heuristics: D also holds every test that still passes when the binary cannot start (it never reaches a server). A, B and C for tests that fail are inferred from the test's source (\`TestClock\`/fake clocks, \`openDatabase\`/\`DB_PATH\`); read them as a starting point for the owner, not a verdict.

## Summary by owning slice

| owner | ${CATEGORIES.join(" | ")} | total |
|---|${CATEGORIES.map(() => "---").join("|")}|---|
${table}
${totals}

## Tests

${sections.join("\n")}`;
}

if (import.meta.main) console.log(report(process.argv[2] ?? "dump.json"));
