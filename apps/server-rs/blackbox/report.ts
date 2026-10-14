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

export function parseJunit(_xml: string): TestResult[] {
  return [];
}

export function evaluate(_results: TestResult[], _manifest: readonly string[], _usesServer: (file: string) => boolean): Verdict {
  return { regressions: ["stub"], unlisted: [], counts: { pass: -1, fail: -1, "not-black-box": -1, skip: -1 } };
}
