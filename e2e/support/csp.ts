// Zero-CSP-violation fixture (OME-191, threat model §8). Every e2e spec takes `test` from here, directly or via
// support/extension.ts or tunnel-support.ts. An init script forwards `securitypolicyviolation` events from every
// frame of every watched context. At teardown, any enforced violation fails the test, and report-only ones
// (Trusted Types in M3) are attached as `csp-report-only.json` without failing it.
// The default `context` is watched automatically. Contexts made by hand must be wrapped: `watchCsp(await browser.newContext())`.
import { test as base, type BrowserContext } from "@playwright/test";

export interface CspViolation {
  readonly disposition: string;
  readonly effectiveDirective: string;
  readonly blockedURI: string;
  readonly documentURI: string;
  readonly sourceFile: string;
  readonly lineNumber: number;
  readonly sample: string;
  readonly originalPolicy: string;
}

export interface CspRecorder {
  readonly enforced: readonly CspViolation[];
  readonly reportOnly: readonly CspViolation[];
  /** Removes and returns the enforced violations, for tests that provoke one on purpose. */
  readonly drain: () => CspViolation[];
}

const BINDING = "__omegaCspViolation";

// One worker runs one test at a time, so module state is per test. Violations that land between tests (late
// events, beforeAll contexts) stay queued and fail the next teardown instead of being lost.
const enforced: CspViolation[] = [];
const reportOnly: CspViolation[] = [];
const watched = new WeakSet<BrowserContext>();

const recorder: CspRecorder = {
  enforced,
  reportOnly,
  drain: () => enforced.splice(0),
};

function forwardViolations(binding: string): void {
  window.addEventListener(
    "securitypolicyviolation",
    (e) => {
      const send: unknown = Reflect.get(window, binding);
      if (typeof send !== "function") return;
      const v = {
        disposition: e.disposition,
        effectiveDirective: e.effectiveDirective,
        blockedURI: e.blockedURI,
        documentURI: e.documentURI,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
        sample: e.sample,
        originalPolicy: e.originalPolicy,
      };
      Promise.resolve(Reflect.apply(send, window, [v])).catch(() => undefined);
    },
    true,
  );
}

const str = (o: object, k: string): string => {
  const v: unknown = Reflect.get(o, k);
  return typeof v === "string" ? v : "";
};

function record(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const lineNumber: unknown = Reflect.get(raw, "lineNumber");
  const v: CspViolation = {
    disposition: str(raw, "disposition"),
    effectiveDirective: str(raw, "effectiveDirective"),
    blockedURI: str(raw, "blockedURI"),
    documentURI: str(raw, "documentURI"),
    sourceFile: str(raw, "sourceFile"),
    lineNumber: typeof lineNumber === "number" ? lineNumber : 0,
    sample: str(raw, "sample"),
    originalPolicy: str(raw, "originalPolicy"),
  };
  (v.disposition === "report" ? reportOnly : enforced).push(v);
}

/** Starts recording CSP violations in `context` (idempotent) and returns it. Call before opening pages. */
export async function watchCsp<C extends BrowserContext>(context: C): Promise<C> {
  if (watched.has(context)) return context;
  watched.add(context);
  await context.exposeBinding(BINDING, (_source, v: unknown) => {
    record(v);
  });
  await context.addInitScript(forwardViolations, BINDING);
  return context;
}

const describe = (v: CspViolation): string =>
  `${v.effectiveDirective} blocked ${v.blockedURI || "(inline)"} on ${v.documentURI}` +
  (v.sourceFile ? ` at ${v.sourceFile}:${String(v.lineNumber)}` : "") +
  (v.sample ? ` sample=${JSON.stringify(v.sample)}` : "");

export const test = base.extend<{ csp: CspRecorder }>({
  context: async ({ context }, use) => {
    await use(await watchCsp(context));
  },
  csp: [
    async ({}, use, testInfo) => {
      await use(recorder);
      const reports = reportOnly.splice(0);
      if (reports.length > 0) {
        await testInfo.attach("csp-report-only.json", { body: JSON.stringify(reports, null, 2), contentType: "application/json" });
      }
      const failures = enforced.splice(0);
      if (failures.length > 0) {
        throw new Error(`${String(failures.length)} enforced CSP violation(s):\n${failures.map((v) => `  - ${describe(v)}`).join("\n")}`);
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
