// Diff → spec selection (OME-820, ADR 0036 decision 1): which e2e, perf and e2e-real specs a diff needs.
// The manifest is `e2e/affected.json`; `scripts/affected.ts` is the CLI. A path no rule maps means the full suite.
import { readFileSync } from "node:fs";
import * as v from "valibot";

const Rule = v.strictObject({
  paths: v.pipe(v.array(v.string()), v.minLength(1)),
  // Files the rule's paths match but it doesn't cover (Bun.Glob's own `!` negates a whole pattern, so it can't do this).
  except: v.optional(v.array(v.string())),
  // Specs this source is covered by. Lane follows the file name (`specKind`).
  specs: v.optional(v.array(v.string())),
  // A wide-blast-radius path (ADR 0036 decision 2): the full suite. `why` is printed.
  full: v.optional(v.boolean()),
  // A changed spec selects itself.
  self: v.optional(v.boolean()),
  why: v.optional(v.string()),
});
const ManifestSchema = v.strictObject({ $comment: v.optional(v.string()), rules: v.array(Rule) });

export type Manifest = v.InferOutput<typeof ManifestSchema>;
export type SpecKind = "e2e" | "firefox" | "perf" | "real";

export interface Selection {
  readonly full: boolean;
  readonly reasons: readonly string[];
  readonly unmapped: readonly string[];
  readonly firefox: readonly string[];
  readonly e2e: readonly string[];
  readonly perf: readonly string[];
  readonly real: readonly string[];
}

export function loadManifest(path: string): Manifest {
  return v.parse(ManifestSchema, JSON.parse(readFileSync(path, "utf8")));
}

export function specKind(path: string): SpecKind | null {
  if (/^e2e\/real\/[^/]+\.real\.ts$/.test(path)) return "real";
  if (/^e2e\/[^/]+\.e2e\.ts$/.test(path)) return "e2e";
  if (/^e2e\/[^/]+\.firefox\.ts$/.test(path)) return "firefox";
  if (/^perf\/[^/]+\.perf\.ts$/.test(path)) return "perf";
  return null;
}

export const isSpec = (path: string): boolean => specKind(path) !== null;

/**
 * `existing`, when given, is the head's tree: selected specs not in it are dropped (a diff that deletes a spec), and an
 * unmapped path picks every e2e-real spec in it, since an unmapped path is the clearest case of "when unsure, include it".
 */
export function select(manifest: Manifest, changed: readonly string[], existing?: ReadonlySet<string>): Selection {
  const rules = manifest.rules.map((r) => ({ ...r, globs: r.paths.map((p) => new Bun.Glob(p)), not: (r.except ?? []).map((p) => new Bun.Glob(p)) }));
  const reasons: string[] = [];
  const unmapped: string[] = [];
  const picked = new Set<string>();
  for (const file of changed) {
    const hits = rules.filter((r) => r.globs.some((g) => g.match(file)) && !r.not.some((g) => g.match(file)));
    if (hits.length === 0) {
      unmapped.push(file);
      reasons.push(`${file} is not mapped by e2e/affected.json`);
      continue;
    }
    for (const r of hits) {
      if (r.full === true) {
        const glob = r.paths.find((p) => new Bun.Glob(p).match(file)) ?? r.paths.join(", ");
        reasons.push(`${file} matches ${glob} (${r.why ?? "wide blast radius"})`);
      }
      if (r.self === true && isSpec(file)) picked.add(file);
      for (const s of r.specs ?? []) picked.add(s);
    }
  }
  if (unmapped.length > 0) for (const f of existing ?? []) if (specKind(f) === "real") picked.add(f);
  const kept = [...picked].filter((s) => existing?.has(s) ?? true).sort();
  const of = (k: SpecKind) => kept.filter((s) => specKind(s) === k);
  return { full: reasons.length > 0, reasons, unmapped, firefox: of("firefox"), e2e: of("e2e"), perf: of("perf"), real: of("real") };
}

export interface AffectedArgs {
  readonly base: string;
  readonly head: string;
  readonly run: boolean;
  readonly e2e: boolean;
}

const FLAGS: ReadonlySet<string> = new Set(["--run", "--e2e"]);

export function affectedArgs(argv: readonly string[]): AffectedArgs {
  const pos: string[] = [];
  const flags = new Set<string>();
  for (const a of argv) {
    if (a.startsWith("-")) {
      if (!FLAGS.has(a)) throw new Error(`unknown flag ${a} (known: ${[...FLAGS].join(", ")})`);
      flags.add(a);
    } else pos.push(a);
  }
  const [base, head = "HEAD", ...rest] = pos;
  if (base === undefined) throw new Error("usage: bun run affected <base> [head] [--run [--e2e]] (missing base)");
  if (rest.length > 0) throw new Error(`too many arguments: ${rest.join(" ")}`);
  if (flags.has("--e2e") && !flags.has("--run")) throw new Error("--e2e needs --run");
  return { base, head, run: flags.has("--run"), e2e: flags.has("--e2e") };
}
