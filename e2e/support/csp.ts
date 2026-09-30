// Zero-CSP-violation fixture (OME-198, threat model §8). Every e2e spec takes `test` from here, directly or via
// support/extension.ts or tunnel-support.ts. An init script forwards `securitypolicyviolation` events from every
// frame of every watched context, and CSP console errors are recorded too. Each violation normally shows up once in
// each channel, so a console error beyond the event count means one the init script couldn't see (a worker, an
// extension page). At teardown, any enforced violation fails the test, and report-only ones (Trusted Types in M3)
// are attached as `csp-report-only.json` without failing it.
// Only our documents count (OME-218): a violation in a third-party frame (a provider's player blocking its own script)
// is that provider's policy, which ours never governs. Those are attached as `csp-third-party.json` without failing.
// Ours: the top page's origin, every loopback origin (site, server, fixtures) and non-http(s) documents (extension
// pages, about:srcdoc, blob:). Anything unparseable counts as ours, so the scope can only fail closed.
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
  /** Enforced violations in third-party documents, by their own policies: evidence, never a failure. */
  readonly thirdParty: readonly CspViolation[];
  /** Enforced CSP console errors this test, including ones whose event was drained. */
  readonly console: readonly string[];
  /** Removes and returns the enforced violations, for tests that provoke one on purpose. */
  readonly drain: () => CspViolation[];
  /** Removes and returns the enforced console lines matching `pattern`, for console-only ones provoked on purpose
   * (e.g. a refused `frame-ancestors`, which fires no event in the embedder). */
  readonly drainConsole: (pattern: RegExp) => string[];
}

const BINDING = "__omegaCspViolation";

// One worker runs one test at a time, so module state is per test. Violations that land between tests (late
// events, beforeAll contexts) stay queued and fail the next teardown instead of being lost.
const enforced: CspViolation[] = [];
const reportOnly: CspViolation[] = [];
const thirdParty: CspViolation[] = [];
const consoleThirdParty: string[] = [];
const consoleEnforced: string[] = [];
const consoleReportOnly: string[] = [];
let enforcedEvents = 0; // drained ones included, to match against consoleEnforced
const watched = new WeakSet<BrowserContext>();

const recorder: CspRecorder = {
  enforced,
  reportOnly,
  thirdParty,
  console: consoleEnforced,
  drain: () => enforced.splice(0),
  drainConsole: (pattern) => {
    const matched = consoleEnforced.filter((t) => pattern.test(t));
    const kept = consoleEnforced.filter((t) => !pattern.test(t));
    consoleEnforced.splice(0, consoleEnforced.length, ...kept);
    return matched;
  },
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a violation in `documentURI`, on a page whose top document is `topURL`, is ours to fail on. */
export function isOurDocument(documentURI: string, topURL: string): boolean {
  if (!URL.canParse(documentURI)) return true;
  const doc = new URL(documentURI);
  if (doc.protocol !== "https:" && doc.protocol !== "http:") return true;
  if (LOOPBACK.has(doc.hostname) || doc.hostname.endsWith(".localhost")) return true;
  return URL.canParse(topURL) && new URL(topURL).origin === doc.origin;
}

function record(raw: unknown, topURL: string): void {
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
  if (v.disposition === "report") {
    reportOnly.push(v);
  } else if (!isOurDocument(v.documentURI, topURL)) {
    thirdParty.push(v);
  } else {
    enforced.push(v);
    enforcedEvents += 1;
  }
}

const CSP_CONSOLE = /Content Security Policy|Trusted ?Types?\b|'Trusted(HTML|Script|ScriptURL)'/;

function recordConsole(type: string, text: string, url: string, topURL: string): void {
  if (type !== "error" || !CSP_CONSOLE.test(text)) return;
  if (url !== "" && !isOurDocument(url, topURL)) {
    consoleThirdParty.push(text);
    return;
  }
  (text.startsWith("[Report Only]") ? consoleReportOnly : consoleEnforced).push(text);
}

/** Starts recording CSP violations in `context` (idempotent) and returns it. Call before opening pages. */
export async function watchCsp<C extends BrowserContext>(context: C): Promise<C> {
  if (watched.has(context)) return context;
  watched.add(context);
  await context.exposeBinding(BINDING, (source, v: unknown) => {
    record(v, source.page.url());
  });
  await context.addInitScript(forwardViolations, BINDING);
  context.on("console", (msg) => {
    recordConsole(msg.type(), msg.text(), msg.location().url, msg.page()?.url() ?? "");
  });
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
      const reportLines = consoleReportOnly.splice(0);
      if (reports.length > 0 || reportLines.length > 0) {
        const body = JSON.stringify({ violations: reports, console: reportLines }, null, 2);
        await testInfo.attach("csp-report-only.json", { body, contentType: "application/json" });
      }
      const foreign = thirdParty.splice(0);
      const foreignLines = consoleThirdParty.splice(0);
      if (foreign.length > 0 || foreignLines.length > 0) {
        const body = JSON.stringify({ violations: foreign, console: foreignLines }, null, 2);
        await testInfo.attach("csp-third-party.json", { body, contentType: "application/json" });
      }
      const failures = enforced.splice(0).map(describe);
      const lines = consoleEnforced.splice(0);
      failures.push(...lines.slice(enforcedEvents).map((t) => `console only: ${t}`));
      enforcedEvents = 0;
      if (failures.length > 0) {
        throw new Error(`${String(failures.length)} enforced CSP violation(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
