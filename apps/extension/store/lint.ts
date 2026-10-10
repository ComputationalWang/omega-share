import * as v from "valibot";

const Finding = v.looseObject({ code: v.string(), message: v.string(), file: v.optional(v.string()) });
const LintOutput = v.looseObject({ errors: v.array(Finding), warnings: v.array(Finding) });

export interface LintResult {
  /** `CODE file: message` per finding. */
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

const describe = (f: v.InferOutput<typeof Finding>): string => `${f.code} ${f.file ?? ""}: ${f.message}`;

/** Mozilla's `web-ext lint` (the AMO validator) on an unpacked extension directory (OME-593). The Firefox store build must have 0 of each. */
export async function webExtLint(dir: string): Promise<LintResult> {
  const proc = Bun.spawn(["bunx", "web-ext", "lint", "--source-dir", dir, "--output", "json", "--boring"], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    throw new Error(`web-ext lint printed no JSON:\n${out}\n${err}`);
  }
  const parsed = v.parse(LintOutput, json);
  return { errors: parsed.errors.map(describe), warnings: parsed.warnings.map(describe) };
}

/** The findings that fail `ext:store`: every error and every warning (OME-743: none is accepted). */
export function lintProblems(result: LintResult): string[] {
  return [...result.errors, ...result.warnings];
}
