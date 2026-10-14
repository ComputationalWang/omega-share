/**
 * Builds classification.md: every apps/server/test test, its category and the slice that owns making
 * it pass against the Rust binary. Usage: `bun run blackbox --dump=dump.json`, then
 * `bun apps/server-rs/blackbox/classify.ts dump.json > apps/server-rs/blackbox/classification.md`.
 */

export type Category = "A" | "A*" | "B" | "C" | "D" | "E" | "skipped";

export interface Evidence {
  status: "pass" | "fail" | "not-black-box" | "skip";
  /** Passes with a binary that cannot start: it never touches a server. */
  serverFree: boolean;
  /** The failure message (the `NotBlackBox` reason for a refused option). */
  reason: string;
  /** The test's own source, for fixtures and spies. */
  source: string;
  /** The file holds shell-script tests: not server code. */
  notServer: boolean;
}

export function categorize(_e: Evidence): Category {
  return "A";
}
