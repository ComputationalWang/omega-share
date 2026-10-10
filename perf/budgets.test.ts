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
    expect(FRAME_PROVIDERS).toEqual(["youtube", "twitchVod", "twitchLive", "vimeo", "generic"]);
  });

  test("each provider has frame, work and missed-vsync rows with a chat burst, at the plain room's budgets (OME-594)", () => {
    const rows = [
      { base: "chat.frameP95", plain: "site.frameP95.generic", docMetric: "Frame rate with a chat burst, 8 avatars + video playing" },
      { base: "chat.workP95", plain: "site.frameWorkP95.generic", docMetric: "Main-thread work per frame with a chat burst, 8 avatars + video playing" },
      { base: "chat.missedVsync", plain: "site.missedVsync.generic", docMetric: "Missed vsyncs with a chat burst, 8 avatars + video playing" },
    ];
    for (const r of rows) {
      const plain = BUDGETS.find((x) => x.id === r.plain);
      for (const provider of FRAME_PROVIDERS) {
        const b = BUDGETS.find((x) => x.id === `${r.base}.${provider}`);
        expect(b, `${r.base}.${provider}`).toBeDefined();
        expect([b?.area, b?.docMetric, b?.unit, b?.limit, b?.comparator]).toEqual(["Site", r.docMetric, plain?.unit, plain?.limit, "<="]);
      }
    }
  });

  test("each provider has frame, work and missed-vsync rows on a phone, at the plain room's budgets (OME-596)", () => {
    const rows = [
      { base: "phone.frameP95", plain: "site.frameP95.generic", docMetric: "Frame rate on a phone, 8 avatars + video playing" },
      { base: "phone.workP95", plain: "site.frameWorkP95.generic", docMetric: "Main-thread work per frame on a phone, 8 avatars + video playing" },
      { base: "phone.missedVsync", plain: "site.missedVsync.generic", docMetric: "Missed vsyncs on a phone, 8 avatars + video playing" },
    ];
    for (const r of rows) {
      const plain = BUDGETS.find((x) => x.id === r.plain);
      for (const provider of FRAME_PROVIDERS) {
        const b = BUDGETS.find((x) => x.id === `${r.base}.${provider}`);
        expect(b, `${r.base}.${provider}`).toBeDefined();
        expect([b?.area, b?.docMetric, b?.unit, b?.limit, b?.comparator]).toEqual(["Site", r.docMetric, plain?.unit, plain?.limit, "<="]);
      }
    }
  });

  test("each provider has frame, work and missed-vsync rows in full screen, at the plain room's budgets, and a long-task row for entering and leaving (OME-597)", () => {
    const rows = [
      { base: "fs.frameP95", plain: "site.frameP95.generic", docMetric: "Frame rate in full screen, 8 avatars + video playing" },
      { base: "fs.workP95", plain: "site.frameWorkP95.generic", docMetric: "Main-thread work per frame in full screen, 8 avatars + video playing" },
      { base: "fs.missedVsync", plain: "site.missedVsync.generic", docMetric: "Missed vsyncs in full screen, 8 avatars + video playing" },
    ];
    for (const r of rows) {
      const plain = BUDGETS.find((x) => x.id === r.plain);
      for (const provider of FRAME_PROVIDERS) {
        const b = BUDGETS.find((x) => x.id === `${r.base}.${provider}`);
        expect(b, `${r.base}.${provider}`).toBeDefined();
        expect([b?.area, b?.docMetric, b?.unit, b?.limit, b?.comparator]).toEqual(["Site", r.docMetric, plain?.unit, plain?.limit, "<="]);
      }
    }
    for (const provider of FRAME_PROVIDERS) {
      const b = BUDGETS.find((x) => x.id === `fs.toggleLongTask.${provider}`);
      expect([b?.area, b?.docMetric, b?.unit, b?.limit, b?.comparator]).toEqual(["Site", "Longest task entering or leaving full screen", "ms", 50, "<="]);
    }
  });

  test("each provider has frame, work and missed-vsync rows for the room tab with the chat popped out, at the plain room's budgets (OME-598)", () => {
    const rows = [
      { base: "pop.frameP95", plain: "site.frameP95.generic", docMetric: "Frame rate with the chat popped out, 8 avatars + video playing" },
      { base: "pop.workP95", plain: "site.frameWorkP95.generic", docMetric: "Main-thread work per frame with the chat popped out, 8 avatars + video playing" },
      { base: "pop.missedVsync", plain: "site.missedVsync.generic", docMetric: "Missed vsyncs with the chat popped out, 8 avatars + video playing" },
    ];
    for (const r of rows) {
      const plain = BUDGETS.find((x) => x.id === r.plain);
      for (const provider of FRAME_PROVIDERS) {
        const b = BUDGETS.find((x) => x.id === `${r.base}.${provider}`);
        expect(b, `${r.base}.${provider}`).toBeDefined();
        expect([b?.area, b?.docMetric, b?.unit, b?.limit, b?.comparator]).toEqual(["Site", r.docMetric, plain?.unit, plain?.limit, "<="]);
      }
    }
  });

  test("a loaded generic embed has its own frame p95 row at the base budget (ADR 0024, OME-294)", () => {
    const b = BUDGETS.find((x) => x.id === "site.frameP95");
    const row = BUDGETS.find((x) => x.id === "site.frameP95.generic");
    expect(row).toBeDefined();
    expect([row?.docMetric, row?.limit, row?.unit, row?.comparator]).toEqual([b?.docMetric, b?.limit, b?.unit, b?.comparator]);
  });

  test("relay latency under flood is its own row at the relay budget (threat model §8 Q, OME-192)", () => {
    const base = BUDGETS.find((x) => x.id === "server.relayLatency");
    const b = BUDGETS.find((x) => x.id === "server.relayLatencyFlood");
    expect(b?.docMetric).toBe("Relay latency for a control action under flood, localhost");
    expect([b?.area, b?.limit, b?.unit, b?.comparator]).toEqual([base?.area, base?.limit, base?.unit, base?.comparator]);
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

describe("landing budgets (OME-763)", () => {
  test("the Landing section has transfer, LCP, CLS and long-task rows at the doc's limits", () => {
    const want = [
      { id: "landing.transferGzip", unit: "KB", limit: 120, docMetric: "Total transfer at `/` before interaction (gzipped)" },
      { id: "landing.lcp", unit: "ms", limit: 1500, docMetric: "Largest Contentful Paint at `/`" },
      { id: "landing.cls", unit: "score", limit: 0.05, docMetric: "Cumulative Layout Shift at `/`" },
      { id: "landing.longTask", unit: "ms", limit: 50, docMetric: "Longest task before the nickname field is usable" },
    ];
    for (const w of want) {
      const b = BUDGETS.find((x) => x.id === w.id);
      expect(b, w.id).toBeDefined();
      expect([b?.area, b?.docMetric, b?.unit, b?.limit, b?.comparator]).toEqual(["Landing", w.docMetric, w.unit, w.limit, "<="]);
      expect(DOC_ROWS.some(([area, metric]) => area === "Landing" && metric === w.docMetric), w.docMetric).toBe(true);
    }
  });

  test("a CLS score keeps three decimals in the report, so 0.04 and 0.06 don't both read 0.0", () => {
    const cls = BUDGETS.find((x) => x.id === "landing.cls");
    if (!cls) throw new Error("no landing.cls");
    const out = renderReport([evaluate(cls, { id: cls.id, value: 0.062 })]);
    expect(out).toContain("| 0.062 |");
    expect(out).toContain("≤ 0.050");
    expect(out).toContain("FAIL");
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
  test("Firefox: a non-persistent event page (background.scripts) is clean, as Firefox MV3 has no service worker (OME-593)", () => {
    expect(checkManifest({ manifest_version: 3, background: { scripts: ["background.js"] } }, "firefox").persistentBackground).toEqual([]);
  });
  test("Firefox: a persistent or page background, or a service worker Firefox would ignore, is flagged", () => {
    expect(checkManifest({ manifest_version: 3, background: { scripts: ["bg.js"], persistent: true } }, "firefox").persistentBackground.length).toBe(1);
    expect(checkManifest({ manifest_version: 3, background: { page: "bg.html" } }, "firefox").persistentBackground.length).toBe(1);
    expect(checkManifest({ manifest_version: 3, background: { service_worker: "bg.js" } }, "firefox").persistentBackground.length).toBe(1);
  });
});

describe("Firefox extension rows (OME-593)", () => {
  test("each extension budget has a Firefox row at the same limit, with its own doc row", () => {
    for (const base of ["ext.popupToList", "ext.contentScripts", "ext.persistentBackground"]) {
      const b = BUDGETS.find((x) => x.id === base);
      const ff = BUDGETS.find((x) => x.id === base.replace("ext.", "ext.firefox."));
      if (b === undefined || ff === undefined) throw new Error(`no ${base} or its Firefox row`);
      expect([ff.area, ff.limit, ff.unit, ff.comparator]).toEqual([b.area, b.limit, b.unit, b.comparator]);
      expect(ff.docMetric).toBe(`${b.docMetric}, Firefox`);
      expect(DOC_ROWS.some(([, metric]) => metric === ff.docMetric)).toBe(true);
    }
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
