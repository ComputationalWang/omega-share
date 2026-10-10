import { describe, expect, test } from "bun:test";
import { affectedArgs, isSpec, loadManifest, select, specKind, type Manifest } from "./affected-lib";

// Diff → spec manifest (OME-820, ADR 0036 decision 1): `bun run affected <base> [head]` picks the e2e, perf and
// e2e-real specs a diff needs. These tests keep `e2e/affected.json` in step with the tree: every spec is tied to
// the sources it covers, and every tracked file is mapped, so a new path can't slip past the selection unseen.
const ROOT = new URL("..", import.meta.url).pathname;
const manifest = loadManifest(`${ROOT}e2e/affected.json`);
const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT }).stdout.toString().split("\n").filter((f) => f !== "");
const specs = tracked.filter(isSpec);

const fixture: Manifest = {
  rules: [
    { paths: ["packages/shared/**"], full: true, why: "wire contract" },
    { paths: ["docs/**"], why: "docs" },
    { paths: ["e2e/*.e2e.ts", "perf/*.perf.ts", "e2e/real/*.real.ts"], self: true },
    { paths: ["perf/*.ts"], except: ["perf/*.perf.ts"], full: true, why: "perf harness" },
    { paths: ["apps/web/src/chat/**"], specs: ["e2e/chat-log.e2e.ts", "perf/chat.perf.ts"] },
    { paths: ["apps/web/src/player/**"], specs: ["e2e/provider-sync.e2e.ts", "e2e/real/real-providers.real.ts"] },
  ],
};

describe("e2e/affected.json", () => {
  test("lists at least one spec", () => {
    expect(specs.length).toBeGreaterThan(10);
  });

  test("every spec is referenced by a source rule (self rules don't count)", () => {
    const referenced = new Set(manifest.rules.flatMap((r) => r.specs ?? []));
    expect(specs.filter((s) => !referenced.has(s))).toEqual([]);
  });

  test("every referenced spec exists", () => {
    const all = new Set(specs);
    expect(manifest.rules.flatMap((r) => r.specs ?? []).filter((s) => !all.has(s))).toEqual([]);
  });

  test("every tracked file is mapped by a rule", () => {
    const unmapped = select(manifest, tracked).unmapped;
    const dirs = [...new Set(unmapped.map((f) => f.split("/").slice(0, -1).join("/") || "."))];
    expect(dirs).toEqual([]);
  });

  test("every glob still matches a tracked file", () => {
    const stale = manifest.rules.flatMap((r) => r.paths).filter((g) => !tracked.some((f) => new Bun.Glob(g).match(f)));
    expect(stale).toEqual([]);
  });

  test("no glob is a `!` negation (it would match nearly every path; use `except`)", () => {
    expect(manifest.rules.flatMap((r) => [...r.paths, ...(r.except ?? [])]).filter((g) => g.startsWith("!"))).toEqual([]);
  });

  test("a docs or unit-test change picks nothing; a chat change picks chat's specs, not the full suite", () => {
    expect(select(manifest, ["docs/qa/x.md", "apps/web/test/state.test.ts"])).toEqual({ full: false, reasons: [], unmapped: [], e2e: [], perf: [], real: [] });
    const chat = select(manifest, ["apps/web/src/chat/log.ts"]);
    expect([chat.full, chat.perf.includes("perf/chat.perf.ts"), chat.e2e.includes("e2e/chat-log.e2e.ts")]).toEqual([false, true, true]);
  });

  test("unit tests in the harness dirs don't pick the full suite", () => {
    expect(select(manifest, ["perf/run-args.test.ts", "e2e/support/xvfb.test.ts"]).full).toBe(false);
  });

  test("a provider adapter picks the e2e-real lane", () => {
    expect(select(manifest, ["apps/web/src/player/twitch.ts"]).real).toContain("e2e/real/real-providers.real.ts");
  });

  test("full rules say why", () => {
    expect(manifest.rules.filter((r) => r.full === true && (r.why ?? "") === "")).toEqual([]);
  });

  test("ADR 0036's wide-blast-radius paths mean the full suite", () => {
    for (const f of [
      "packages/shared/src/protocol.ts",
      "apps/server/src/ws.ts",
      "apps/server/src/room.ts",
      "playwright.config.ts",
      "e2e/support/room.ts",
      "e2e/fixtures/server.ts",
      "perf/metrics.ts",
      "package.json",
      "bun.lock",
      "apps/web/vite.config.ts",
      "apps/extension/wxt.config.ts",
      "tsconfig.base.json",
    ]) {
      expect({ f, full: select(manifest, [f]).full }).toEqual({ f, full: true });
    }
  });
});

describe("select", () => {
  test("a full rule picks the full suite and says why", () => {
    const s = select(fixture, ["packages/shared/src/x.ts", "apps/web/src/chat/log.ts"]);
    expect(s.full).toBe(true);
    expect(s.reasons).toEqual(["packages/shared/src/x.ts matches packages/shared/** (wire contract)"]);
    expect(s.perf).toEqual(["perf/chat.perf.ts"]);
  });

  test("an unmapped path picks the full suite", () => {
    const s = select(fixture, ["brand-new/thing.ts"]);
    expect(s.full).toBe(true);
    expect(s.unmapped).toEqual(["brand-new/thing.ts"]);
    expect(s.reasons).toEqual(["brand-new/thing.ts is not mapped by e2e/affected.json"]);
  });

  test("a mapped source picks its specs, sorted and once each", () => {
    const s = select(fixture, ["apps/web/src/chat/a.ts", "apps/web/src/chat/b.ts", "apps/web/src/player/yt.ts"]);
    expect(s).toEqual({
      full: false,
      reasons: [],
      unmapped: [],
      e2e: ["e2e/chat-log.e2e.ts", "e2e/provider-sync.e2e.ts"],
      perf: ["perf/chat.perf.ts"],
      real: ["e2e/real/real-providers.real.ts"],
    });
  });

  test("a changed spec picks itself", () => {
    const s = select(fixture, ["e2e/walk.e2e.ts", "perf/load.perf.ts", "e2e/real/real-ads.real.ts"]);
    expect([s.full, s.e2e, s.perf, s.real]).toEqual([false, ["e2e/walk.e2e.ts"], ["perf/load.perf.ts"], ["e2e/real/real-ads.real.ts"]]);
  });

  test("a deleted spec isn't selected", () => {
    const s = select(fixture, ["e2e/gone.e2e.ts"], new Set(["e2e/walk.e2e.ts"]));
    expect(s.e2e).toEqual([]);
  });

  test("except carves files out of a rule", () => {
    expect(select(fixture, ["perf/metrics.ts"]).full).toBe(true);
    expect(select(fixture, ["perf/chat.perf.ts"])).toMatchObject({ full: false, perf: ["perf/chat.perf.ts"] });
  });

  test("docs-only picks nothing", () => {
    expect(select(fixture, ["docs/x.md"])).toEqual({ full: false, reasons: [], unmapped: [], e2e: [], perf: [], real: [] });
  });
});

describe("specKind", () => {
  test("classifies by lane", () => {
    expect(["e2e/a.e2e.ts", "e2e/a.firefox.ts", "perf/a.perf.ts", "e2e/real/a.real.ts", "e2e/support/a.ts"].map(specKind)).toEqual([
      "e2e",
      "e2e",
      "perf",
      "real",
      null,
    ]);
  });
});

describe("affectedArgs", () => {
  test("base, optional head, flags", () => {
    expect(affectedArgs(["origin/main"])).toEqual({ base: "origin/main", head: "HEAD", run: false, e2e: false });
    expect(affectedArgs(["main", "feature", "--run", "--e2e"])).toEqual({ base: "main", head: "feature", run: true, e2e: true });
  });

  test("refuses unknown flags, a missing base and extra args", () => {
    expect(() => affectedArgs([])).toThrow(/base/);
    expect(() => affectedArgs(["main", "--fast"])).toThrow(/unknown flag/);
    expect(() => affectedArgs(["a", "b", "c"])).toThrow(/too many/);
    expect(() => affectedArgs(["main", "--e2e"])).toThrow(/--e2e needs --run/);
  });
});
