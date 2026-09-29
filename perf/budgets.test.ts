import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUDGETS, evaluate, renderReport } from "./budgets";
import { checkManifest, initialJsGzipKb } from "./static-checks";

describe("budgets", () => {
  test("every budget id is unique", () => {
    const ids = BUDGETS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("limits match docs/perf-budgets.md", () => {
    const doc = readFileSync(join(import.meta.dir, "../docs/perf-budgets.md"), "utf8");
    for (const b of BUDGETS) {
      const row = doc.split("\n").find((line) => line.includes(`| ${b.docMetric} |`));
      expect(row, `row for ${b.docMetric}`).toBeDefined();
      const cell = (row ?? "").split("|").at(-2)?.trim() ?? "";
      if (cell.startsWith("none")) {
        expect(b.limit).toBe(0);
        continue;
      }
      const m = /([≤<])\s*([\d.]+)\s*(KB|MB|ms|s)\b/.exec(cell);
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
