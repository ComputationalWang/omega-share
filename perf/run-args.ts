// `bun run perf [flags] [perf/<name>.perf.ts ...]`: flags, and the specs a targeted post-merge check (ADR 0036) runs (OME-763).
export const PERF_FLAGS = ["--no-build", "--rebuild", "--strict", "--soak"] as const;

export interface PerfRunArgs {
  readonly flags: ReadonlySet<string>;
  readonly specs: readonly string[];
}

const KNOWN: ReadonlySet<string> = new Set(PERF_FLAGS);

export function perfRunArgs(argv: readonly string[]): PerfRunArgs {
  const flags = new Set<string>();
  const specs: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-")) {
      if (!KNOWN.has(a)) throw new Error(`unknown flag ${a} (known: ${PERF_FLAGS.join(", ")})`);
      flags.add(a);
    } else {
      if (!/^(?:\.\/)?perf\/[\w.-]+\.perf\.ts$/.test(a)) throw new Error(`not a perf spec: ${a} (expected perf/<name>.perf.ts)`);
      specs.push(a);
    }
  }
  if (flags.has("--rebuild") && flags.has("--no-build")) throw new Error("--rebuild and --no-build contradict each other");
  return { flags, specs };
}
