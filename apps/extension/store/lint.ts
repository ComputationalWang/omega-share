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

/**
 * The one finding we ship with. Desktop only (CEO decision on OME-546): with no `gecko_android` key the add-on is not
 * listed for Android, yet the linter still checks Android against `strict_min_version` 140 and notes that Firefox for
 * Android reads `data_collection_permissions` only from 142. Adding `gecko_android` would make it an Android add-on.
 */
export const ACCEPTED_LINT_WARNINGS = ["KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION"] as const;

/** The findings that fail `ext:store`: every error, and every warning but the accepted ones. */
export function lintProblems(result: LintResult): string[] {
  const accepted = (finding: string): boolean => ACCEPTED_LINT_WARNINGS.some((code) => finding.startsWith(`${code} `));
  return [...result.errors, ...result.warnings.filter((w) => !accepted(w))];
}
