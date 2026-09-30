import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./apps";

// OME-191 (threat model §8): the zero-CSP-violation fixture must cover every e2e spec, so nothing may bypass it.
const E2E = join(ROOT, "e2e");
const sources = readdirSync(E2E, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("fixtures"))
  .map((f) => ({ file: relative(ROOT, join(E2E, f)), text: readFileSync(join(E2E, f), "utf8") }));
const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

test("the scan sees the specs", () => {
  expect(sources.some((s) => s.file === "e2e/room.e2e.ts")).toBe(true);
});

test("no spec or helper takes `test` from @playwright/test directly (only support/csp.ts may)", () => {
  const direct = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*"@playwright\/test"/;
  const offenders = sources.filter((s) => s.file !== "e2e/support/csp.ts" && direct.test(s.text)).map((s) => s.file);
  expect(offenders).toEqual([]);
});

test("every hand-made browser context is wrapped in watchCsp", () => {
  const offenders = sources
    .filter((s) => s.file !== "e2e/support/csp.ts")
    .filter((s) => count(s.text, /\.newContext\(|launchPersistentContext\(/g) > count(s.text, /\bwatchCsp\(/g))
    .map((s) => s.file);
  expect(offenders).toEqual([]);
});
