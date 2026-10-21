// Zero-CSP-violation fixture (OME-198, threat model §8). Every e2e spec takes `test` from here, directly or via
// support/extension.ts or tunnel-support.ts. An init script forwards `securitypolicyviolation` events from every
// frame of every watched context, and CSP console errors are recorded too. Each violation normally shows up once in
// each channel, so a console error beyond the event count means one the init script couldn't see (a worker, an
// extension page). At teardown, any enforced violation fails the test, and report-only ones (Trusted Types in M3)
// are attached as `csp-report-only.json` without failing it.
// Only our documents count (OME-218, support/csp-scope.ts): a violation in a third-party frame (a provider's player
// blocking its own script) is that provider's policy, and is attached as `csp-third-party.json` without failing.
// Console lines can't be placed in a frame, so they aren't scoped: third-party events count toward the event total too.
// The default `context` is watched automatically. Contexts made by hand must be wrapped: `watchCsp(await browser.newContext())`.
import { test as base, type BrowserContext, type Page } from "@playwright/test";
import { isOurDocument } from "./csp-scope";

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
  /** Enforced CSP console errors this test, including ones whose event was drained or was third-party. */
  readonly console: readonly string[];
  /** Removes and returns the enforced violations, for tests that provoke one on purpose. */
  readonly drain: () => CspViolation[];
  /** Removes and returns the enforced console lines matching `pattern`, for console-only ones provoked on purpose
   * (e.g. a refused `frame-ancestors`, which fires no event in the embedder). */
  readonly drainConsole: (pattern: RegExp) => string[];
}

const BINDING = "__omegaCspViolation";

/** `OMEGA_THEME`: a theme id or `off` (the default). A typo is refused, so a run never reads as themed while it isn't (OME-750). */
const PINNED_THEME = process.env["OMEGA_THEME"] ?? "off";
if (!["off", "halloween", "sinterklaas", "christmas", "valentine", "easter"].includes(PINNED_THEME)) {
  throw new Error(`OMEGA_THEME must be a theme id or off, not ${JSON.stringify(PINNED_THEME)}`);
}

// One worker runs one test at a time, so module state is per test. Violations that land between tests (late
// events, beforeAll contexts) stay queued and fail the next teardown instead of being lost.
const enforced: CspViolation[] = [];
const reportOnly: CspViolation[] = [];
const thirdParty: CspViolation[] = [];
const consoleEnforced: string[] = [];
const consoleReportOnly: string[] = [];
let enforcedEvents = 0; // drained and third-party ones included, to match against consoleEnforced
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
  } else {
    (isOurDocument(v.documentURI, topURL) ? enforced : thirdParty).push(v);
    enforcedEvents += 1;
  }
}

const CSP_CONSOLE = /Content Security Policy|Trusted ?Types?\b|'Trusted(HTML|Script|ScriptURL)'/;

function recordConsole(type: string, text: string): void {
  if (type !== "error" || !CSP_CONSOLE.test(text)) return;
  (text.startsWith("[Report Only]") ? consoleReportOnly : consoleEnforced).push(text);
}

/** In the page: an explicit `leave` through the dev handle, if the page is in a room. */
function leaveRoom(): void {
  const debug: unknown = Reflect.get(window, "__omega");
  const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
  const send: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "send") : null;
  if (typeof send === "function") Reflect.apply(send, room, [{ type: "leave" }]);
}

/** Starts recording CSP violations in `context` (idempotent) and returns it. Call before opening pages. */
/** `tour`: leave the first-visit tour (OME-1587) on; every other spec starts with it seen, so no chip sits over the room. */
export async function watchCsp<C extends BrowserContext>(context: C, { tour = false }: { readonly tour?: boolean } = {}): Promise<C> {
  if (watched.has(context)) return context;
  watched.add(context);
  // A test that closes its browser is done with the room for good: say so first, as Leave does (ADR 0043). Without it
  // the server holds each closed tab's member, name and seat for the grace window, and the next test in the same room
  // finds its nickname taken or its seat full. Through the test handle `window.__omega` (dev builds and the perf build,
  // apps/web/src/test-handle.ts); best effort.
  const close = context.close.bind(context);
  context.close = async (options) => {
    // Bounded: a page stuck in a dialog must not hold the close up. Specs that test a dirty drop close the page instead.
    const leave = (p: Page): Promise<void> => Promise.race([p.evaluate(leaveRoom).catch(() => undefined), new Promise<void>((r) => setTimeout(r, 2000))]);
    await Promise.all(context.pages().map(leave));
    return close(options);
  };
  await context.exposeBinding(BINDING, (source, v: unknown) => {
    record(v, source.page.url());
  });
  await context.addInitScript(forwardViolations, BINDING);
  // The holiday theme is pinned (ADR 0052): `off` unless OMEGA_THEME names one (QA's perf rows run with christmas). Otherwise
  // from Oct 24 the date alone would add hats, decor and an effect loop that redraws the room, and render-count and
  // draw-order checks would change with the calendar. A spec's own init script runs after this one, so its value wins.
  await context.addInitScript((theme) => {
    try {
      localStorage.setItem("omega.theme", theme);
    } catch {
      // Opaque origins (about:blank, data:) have no storage.
    }
  }, PINNED_THEME);
  if (!tour) {
    await context.addInitScript(() => {
      try {
        if (localStorage.getItem("omega.hints") === null) localStorage.setItem("omega.hints", '{"seen":true}');
      } catch {
        // Opaque origins have no storage.
      }
    });
  }
  context.on("console", (msg) => {
    recordConsole(msg.type(), msg.text());
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
      if (foreign.length > 0) {
        const body = JSON.stringify({ violations: foreign }, null, 2);
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
