/** Reads `bun test --reporter=junit` output and judges it against the manifest. Pure, so it is tested. */

export type Status = "pass" | "fail" | "not-black-box" | "skip";

export interface TestResult {
  /** `file::classname::name`, the manifest's key. */
  id: string;
  file: string;
  status: Status;
}

export interface Verdict {
  /** Listed in the manifest but not passing: fails the run. */
  regressions: string[];
  /** Passing, exercising a server, and not listed: candidates to add. */
  unlisted: string[];
  counts: Record<Status, number>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e] ?? "");

function attribute(attrs: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return unescape(match?.[1] ?? "");
}

export function parseJunit(xml: string): TestResult[] {
  const results: TestResult[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const file = attribute(attrs, "file");
    let status: Status = "pass";
    if (body.includes("<skipped")) status = "skip";
    else if (body.includes("<failure") || body.includes("<error"))
      status = body.includes("NotBlackBox") ? "not-black-box" : "fail";
    results.push({ id: `${file}::${attribute(attrs, "classname")}::${attribute(attrs, "name")}`, file, status });
  }
  return results;
}

export function evaluate(
  results: TestResult[],
  manifest: readonly string[],
  usesServer: (file: string) => boolean,
): Verdict {
  const passing = new Set(results.filter((t) => t.status === "pass").map((t) => t.id));
  const listed = new Set(manifest);
  const counts: Verdict["counts"] = { pass: 0, fail: 0, "not-black-box": 0, skip: 0 };
  for (const t of results) counts[t.status]++;
  return {
    regressions: manifest.filter((id) => !passing.has(id)),
    unlisted: results.filter((t) => t.status === "pass" && !listed.has(t.id) && usesServer(t.file)).map((t) => t.id),
    counts,
  };
}
