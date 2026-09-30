import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ROOM_MEMBERS } from "@omega/shared";
import { BUDGETS, FRAME_PROVIDERS, evaluate, renderReport } from "./budgets";
import { soakPlan } from "./soak";
import { checkManifest, initialJsGzipKb } from "./static-checks";

const DOC = readFileSync(join(import.meta.dir, "../docs/perf-budgets.md"), "utf8");
/** Table rows of docs/perf-budgets.md as [area, metric, budget] cells, header and separator skipped. */
const DOC_ROWS = DOC.split("\n")
  .filter((line) => line.startsWith("| ") && !line.startsWith("| Area ") && !line.startsWith("|---"))
  .map((line) => line.split("|").slice(1, -1).map((c) => c.trim()));

describe("budgets", () => {
  test("every budget id is unique", () => {
    const ids = BUDGETS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every row in docs/perf-budgets.md has at least one budget, so none is missing from the report", () => {
    expect(DOC_ROWS.length).toBeGreaterThan(0);
    const covered = new Set(BUDGETS.map((b) => b.docMetric));
    for (const [, metric] of DOC_ROWS) expect(covered.has(metric ?? ""), `budget for doc row "${metric ?? ""}"`).toBe(true);
  });

  test("load-test budgets hold another budget at the doc's room size, which is MAX_ROOM_MEMBERS", () => {
    const load = BUDGETS.filter((b) => b.load !== undefined);
    expect(load.map((b) => b.id).sort()).toEqual(["load.frameP95", "load.relayLatency"]);
    for (const b of load) {
      const row = DOC_ROWS.find(([, metric]) => metric === b.docMetric);
      expect(Number(row?.[2])).toBe(b.load?.members ?? Number.NaN);
      expect(b.load?.members).toBe(MAX_ROOM_MEMBERS);
      const base = BUDGETS.find((x) => x.id === b.load?.of);
      if (base === undefined) throw new Error(`no base budget ${b.load?.of ?? ""} for ${b.id}`);
      expect([b.limit, b.unit, b.comparator]).toEqual([base.limit, base.unit, base.comparator]);
    }
  });

  test("each M2 provider has its own merge-blocking sync.spread and site.frameP95 row at the base budget (OME-131)", () => {
    for (const base of ["sync.spread", "site.frameP95"]) {
      const b = BUDGETS.find((x) => x.id === base);
      if (b === undefined) throw new Error(`no ${base}`);
      for (const provider of ["twitchVod", "twitchLive", "vimeo"]) {
        const row = BUDGETS.find((x) => x.id === `${base}.${provider}`);
        expect(row, `${base}.${provider}`).toBeDefined();
        expect([row?.docMetric, row?.limit, row?.unit, row?.comparator]).toEqual([b.docMetric, b.limit, b.unit, b.comparator]);
      }
    }
  });

  test("each provider has a frame work-time and a missed-vsync row next to its frame p95 (ADR 0017, OME-192)", () => {
    const rows = [
      { base: "site.frameWorkP95", docMetric: "Main-thread work per frame, 8 avatars + video playing", unit: "ms", limit: 8 },
      { base: "site.missedVsync", docMetric: "Missed vsyncs, 8 avatars + video playing", unit: "%", limit: 1 },
    ];
    for (const r of rows) {
      for (const provider of FRAME_PROVIDERS) {
        const b = BUDGETS.find((x) => x.id === `${r.base}.${provider}`);
        expect(b, `${r.base}.${provider}`).toBeDefined();
        expect([b?.area, b?.docMetric, b?.unit, b?.limit, b?.comparator]).toEqual(["Site", r.docMetric, r.unit, r.limit, "<="]);
      }
    }
    expect(FRAME_PROVIDERS).toEqual(["youtube", "twitchVod", "twitchLive", "vimeo"]);
  });

  test("limits match docs/perf-budgets.md", () => {
    for (const b of BUDGETS) {
      if (b.load !== undefined) continue;
      const row = DOC.split("\n").find((line) => line.includes(`| ${b.docMetric} |`));
      expect(row, `row for ${b.docMetric}`).toBeDefined();
      const cell = (row ?? "").split("|").at(-2)?.trim() ?? "";
      if (cell.startsWith("none")) {
        expect(b.limit).toBe(0);
        continue;
      }
      const m = /([≤<])\s*([\d.]+)\s*(KB|MB|ms|s|%)(?![A-Za-z])/.exec(cell);
      expect(m, `numeric budget in "${cell}"`).not.toBeNull();
      const [, op, num, unit] = m ?? [];
      const limit = Number(num) * (unit === "s" ? 1000 : 1);
      expect(b.limit).toBe(limit);
      expect(b.comparator).toBe(op === "≤" ? "<=" : "<");
    }
  });
});

describe("evaluate", () => {
  const b = { id: "x", area: "Site", metric: "m", docMetric: "m", unit: "ms", limit: 100, comparator: "<=" } as const;

  test("passes at the limit for <=", () => {
    expect(evaluate(b, { id: "x", value: 100 }).status).toBe("pass");
  });
  test("renders a percentage budget with its unit", () => {
    const pct = { ...b, unit: "%", limit: 1 } as const;
    const out = renderReport([evaluate(pct, { id: "x", value: 0 })]);
    expect(out).toContain("| 0.0 % | ≤ 1.0 % |");
  });
  test("fails over the limit", () => {
    expect(evaluate(b, { id: "x", value: 100.1 }).status).toBe("fail");
  });
  test("fails at the limit for <", () => {
    expect(evaluate({ ...b, comparator: "<" }, { id: "x", value: 100 }).status).toBe("fail");
  });
  test("pending when not measured", () => {
    const r = evaluate(b, undefined);
    expect(r.status).toBe("pending");
    expect(r.note).toContain("not measured");
  });
  test("pending keeps the reason", () => {
    expect(evaluate(b, { id: "x", pending: "site not built" }).note).toBe("site not built");
  });
});

describe("renderReport", () => {
  test("renders a markdown table with statuses and a summary", () => {
    const b = BUDGETS[0];
    if (!b) throw new Error("no budgets");
    const out = renderReport([evaluate(b, { id: b.id, value: b.limit * 2 })]);
    expect(out).toContain("| Status |");
    expect(out).toContain("FAIL");
    expect(out).toContain("1 failed");
  });
});

describe("checkManifest", () => {
  test("clean MV3 manifest has no violations", () => {
    const r = checkManifest({ manifest_version: 3, background: { service_worker: "background.js" } });
    expect(r.contentScripts).toBe(0);
    expect(r.persistentBackground).toEqual([]);
  });
  test("counts declared content scripts", () => {
    const r = checkManifest({ manifest_version: 3, content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] });
    expect(r.contentScripts).toBe(1);
  });
  test("flags persistent or page backgrounds", () => {
    const r = checkManifest({ manifest_version: 2, background: { page: "bg.html", persistent: true, scripts: ["x.js"] } });
    expect(r.persistentBackground.length).toBe(4);
  });
  test("rejects non-object input", () => {
    expect(() => checkManifest("nope")).toThrow();
  });
});

describe("initialJsGzipKb", () => {
  test("sums gzipped entry + modulepreload scripts, ignores dynamic chunks and remote src", () => {
    const dir = mkdtempSync(join(tmpdir(), "omega-perf-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets/entry.js"), "a".repeat(10_000));
    writeFileSync(join(dir, "assets/vendor.js"), "b".repeat(10_000));
    writeFileSync(join(dir, "assets/lazy.js"), "c".repeat(10_000));
    writeFileSync(
      join(dir, "index.html"),
      `<script type="module" crossorigin src="/assets/entry.js"></script>
       <link rel="modulepreload" crossorigin href="/assets/vendor.js">
       <script src="https://example.com/remote.js"></script>`,
    );
    const r = initialJsGzipKb(dir);
    expect(r.files).toEqual(["assets/entry.js", "assets/vendor.js"]);
    expect(r.kb).toBeGreaterThan(0);
    expect(r.kb).toBeLessThan(1);
  });
});

describe("soakPlan", () => {
  test("skips unless OMEGA_PERF_SOAK=1, and says how to run it", () => {
    const p = soakPlan({});
    expect(p.run).toBe(false);
    expect(p.run ? "" : p.reason).toContain("bun run perf --soak");
  });
  test("defaults to the budget's 10 minutes", () => {
    expect(soakPlan({ OMEGA_PERF_SOAK: "1" })).toEqual({ run: true, durationMs: 600_000, full: true });
  });
  test("OMEGA_SOAK_MS shortens it, but a short soak is not a full measurement", () => {
    expect(soakPlan({ OMEGA_PERF_SOAK: "1", OMEGA_SOAK_MS: "30000" })).toEqual({ run: true, durationMs: 30_000, full: false });
  });
  test("rejects a nonsense duration", () => {
    expect(() => soakPlan({ OMEGA_PERF_SOAK: "1", OMEGA_SOAK_MS: "soon" })).toThrow();
    expect(() => soakPlan({ OMEGA_PERF_SOAK: "1", OMEGA_SOAK_MS: "0" })).toThrow();
  });
});
