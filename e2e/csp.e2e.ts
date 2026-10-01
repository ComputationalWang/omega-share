// Self-test for the zero-CSP-violation fixture (OME-198, threat model §8): enforced violations fail the test,
// report-only (Trusted Types) ones are only reported, and hand-made contexts are watched too.
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test, watchCsp } from "./support/csp";
import { joinRoom, leaveAll } from "./support/room";

const ENFORCED = `${URLS.fixtures}/__csp/enforced`;
const REPORT_ONLY = `${URLS.fixtures}/__csp/report-only`;
const INLINE = `${URLS.fixtures}/__csp/inline-script`;
const CLEAN = `${URLS.fixtures}/__csp/clean`;
const STRICT = "default-src 'self'; script-src 'self'";
/** A provider's player frame with its own policy (OME-218: Vimeo's 404 player blocks its own Cloudflare script). */
const THIRD_PARTY = "https://player.third-party.test/video/1";
const EMBEDS_THIRD_PARTY = `${URLS.fixtures}/__csp/embeds-third-party`;
/** Ours even though it's another origin: every loopback origin is a server we run (site, server, fixtures). */
const LOOPBACK_OTHER = `${URLS.fixtures.replace("localhost", "127.0.0.1")}/__csp/enforced`;
const EMBEDS_LOOPBACK = `${URLS.fixtures}/__csp/embeds-loopback`;
/** Our page, where a third-party script (a provider's API) does something our policy blocks: still ours. */
const THIRD_PARTY_SCRIPT = "https://cdn.third-party.test/api.js";
const RUNS_THIRD_PARTY = `${URLS.fixtures}/__csp/runs-third-party`;
const html = (body: string): string => `<!doctype html><title>csp</title><body>${body}</body>`;

test.describe("csp fixture", () => {
  test.beforeEach(async ({ context }) => {
    await context.route(ENFORCED, (r) =>
      r.fulfill({ contentType: "text/html", headers: { "content-security-policy": "img-src 'none'" }, body: html(`<img src="/blocked.png">`) }),
    );
    await context.route(REPORT_ONLY, (r) =>
      r.fulfill({
        contentType: "text/html",
        headers: { "content-security-policy-report-only": "require-trusted-types-for 'script'" },
        body: html(`<div id="t"></div><script>document.getElementById("t").innerHTML = "<b>tt</b>";</script>`),
      }),
    );
    await context.route(INLINE, (r) =>
      r.fulfill({ contentType: "text/html", headers: { "content-security-policy": STRICT }, body: html(`<script>document.title = "ran";</script>`) }),
    );
    await context.route(THIRD_PARTY, (r) =>
      r.fulfill({ contentType: "text/html", headers: { "content-security-policy": STRICT }, body: html(`<script>document.title = "ran";</script>`) }),
    );
    await context.route(EMBEDS_THIRD_PARTY, (r) => r.fulfill({ contentType: "text/html", body: html(`<iframe src="${THIRD_PARTY}"></iframe>`) }));
    await context.route(LOOPBACK_OTHER, (r) =>
      r.fulfill({ contentType: "text/html", headers: { "content-security-policy": "img-src 'none'" }, body: html(`<img src="/blocked.png">`) }),
    );
    await context.route(EMBEDS_LOOPBACK, (r) => r.fulfill({ contentType: "text/html", body: html(`<iframe src="${LOOPBACK_OTHER}"></iframe>`) }));
    await context.route(THIRD_PARTY_SCRIPT, (r) =>
      r.fulfill({ contentType: "text/javascript", body: `const i = document.createElement("img"); i.src = "/blocked.png"; document.body.append(i);` }),
    );
    await context.route(RUNS_THIRD_PARTY, (r) =>
      r.fulfill({ contentType: "text/html", headers: { "content-security-policy": "img-src 'none'" }, body: html(`<script src="${THIRD_PARTY_SCRIPT}"></script>`) }),
    );
    await context.route(CLEAN, (r) =>
      r.fulfill({ contentType: "text/html", headers: { "content-security-policy": STRICT }, body: html(`<p id="ok">clean</p>`) }),
    );
  });

  test("an inline script is recorded from both the event and the console", async ({ page, csp }) => {
    await page.goto(INLINE);
    await expect.poll(() => csp.enforced.length).toBe(1);
    await expect.poll(() => csp.console.length).toBe(1);
    expect(csp.console[0]).toMatch(/inline script/i);
    expect(await page.title()).toBe("csp");
    expect(csp.drain().map((v) => v.effectiveDirective)).toEqual(["script-src-elem"]);
  });

  test("a page with an inline script fails the test", async ({ page, csp }) => {
    test.fail(); // the fixture's teardown must throw; if it doesn't, this test turns red
    await page.goto(INLINE);
    await expect.poll(() => csp.enforced.length).toBe(1);
  });

  test("a clean page under a strict policy passes", async ({ page, csp }) => {
    await page.goto(CLEAN);
    await expect(page.locator("#ok")).toHaveText("clean");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))));
    expect(csp.enforced).toEqual([]);
    expect(csp.console).toEqual([]);
  });

  test("a CSP console error with no matching event fails the test", async ({ page }) => {
    test.fail(); // covers violations the init script can't see (workers, extension pages)
    await page.goto(CLEAN);
    await page.evaluate(() => {
      console.error(`Refused to load the script 'https://evil.example/x.js' because it violates the following Content Security Policy directive: "script-src 'self'".`);
    });
  });

  test("records an enforced violation with its directive", async ({ page, csp }) => {
    await page.goto(ENFORCED);
    await expect.poll(() => csp.enforced.length).toBe(1);
    const [v] = csp.drain();
    expect(v?.effectiveDirective).toBe("img-src");
    expect(v?.documentURI).toBe(ENFORCED);
  });

  test("an undrained enforced violation fails the test", async ({ page, csp }) => {
    test.fail(); // the fixture's teardown must throw; if it doesn't, this test turns red
    await page.goto(ENFORCED);
    await expect.poll(() => csp.enforced.length).toBe(1);
  });

  test("a report-only Trusted Types violation is collected but does not fail", async ({ page, csp }) => {
    await page.goto(REPORT_ONLY);
    await expect.poll(() => csp.reportOnly.length).toBe(1);
    expect(csp.reportOnly[0]?.effectiveDirective).toBe("require-trusted-types-for");
    expect(csp.enforced).toEqual([]);
    expect(csp.console).toEqual([]);
  });

  test("a third-party frame's own policy is kept as evidence and does not fail", async ({ page, csp }) => {
    await page.goto(EMBEDS_THIRD_PARTY);
    await expect.poll(() => csp.thirdParty.length).toBe(1);
    expect(csp.thirdParty[0]?.documentURI).toBe(THIRD_PARTY);
    expect(csp.thirdParty[0]?.effectiveDirective).toBe("script-src-elem");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 200))));
    expect(csp.enforced).toEqual([]);
  });

  test("a violation in a loopback frame of another origin is ours", async ({ page, csp }) => {
    await page.goto(EMBEDS_LOOPBACK);
    await expect.poll(() => csp.enforced.length).toBe(1);
    expect(csp.drain().map((v) => [v.effectiveDirective, v.documentURI])).toEqual([["img-src", LOOPBACK_OTHER]]);
    expect(csp.thirdParty).toEqual([]);
  });

  test("a violation in our page caused by a third-party script is ours, event and console", async ({ page, csp }) => {
    await page.goto(RUNS_THIRD_PARTY);
    await expect.poll(() => csp.enforced.length).toBe(1);
    await expect.poll(() => csp.console.length).toBe(1);
    expect(csp.drain().map((v) => v.documentURI)).toEqual([RUNS_THIRD_PARTY]);
    expect(csp.thirdParty).toEqual([]);
  });

  test("a hand-made context is watched once wrapped", async ({ browser, csp }) => {
    const context = await watchCsp(await browser.newContext());
    try {
      await context.route(ENFORCED, (r) =>
        r.fulfill({ contentType: "text/html", headers: { "content-security-policy": "img-src 'none'" }, body: html(`<img src="/blocked.png">`) }),
      );
      const page = await context.newPage();
      await page.goto(ENFORCED);
      await expect.poll(() => csp.enforced.length).toBe(1);
      csp.drain();
    } finally {
      await context.close();
    }
  });
});

test.describe("csp: site", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  test("joining a room raises no enforced violation", async ({ browser, csp }) => {
    const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 1, nicknamePrefix: "csp" });
    try {
      expect(await clients[0]?.page.evaluate(() => typeof Reflect.get(window, "__omegaCspViolation"))).toBe("function");
      expect(csp.enforced).toEqual([]);
    } finally {
      await leaveAll(clients);
    }
  });

  // Moved from sync.e2e.ts (OME-341): it needs a room, not a video.
  test("the CSP blocks a non-allowlisted script", async ({ browser, csp }) => {
    const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 1, nicknamePrefix: "csp-block" });
    try {
      const [client] = clients;
      if (!client) throw new Error("no client");
      const { page } = client;
      // If CSP let them through, these would run and bump the counter.
      const pwn = { contentType: "text/javascript", body: "window.__pwned = (window.__pwned ?? 0) + 1;" };
      for (const url of ["https://evil.example/pwn.js", "https://www.youtube.com/not-the-api.js"]) {
        await page.route(url, (r) => r.fulfill(pwn));
      }
      const blocked = await page.evaluate(async (urls) => {
        const violations: string[] = [];
        document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
        const load = (src: string) =>
          new Promise<string>((resolve) => {
            const s = document.createElement("script");
            s.src = src;
            s.onload = () => {
              resolve("loaded");
            };
            s.onerror = () => {
              resolve("blocked");
            };
            document.head.append(s);
          });
        const results = await Promise.all(urls.map(load));
        // Inline script too: script-src has no 'unsafe-inline'.
        const inline = document.createElement("script");
        inline.textContent = "window.__pwned = (window.__pwned ?? 0) + 1;";
        document.head.append(inline);
        await new Promise((r) => setTimeout(r, 100));
        return { results, violations, pwned: (window as unknown as { __pwned?: number }).__pwned ?? 0 };
      }, ["https://evil.example/pwn.js", "https://www.youtube.com/not-the-api.js"]);
      expect(blocked.results).toEqual(["blocked", "blocked"]);
      expect(blocked.pwned).toBe(0);
      expect(blocked.violations).toEqual(
        expect.arrayContaining([
          "script-src-elem https://evil.example/pwn.js",
          "script-src-elem https://www.youtube.com/not-the-api.js",
          "script-src-elem inline",
        ]),
      );
      // Provoked on purpose, so take them off the zero-violation fixture's list (OME-198).
      await expect.poll(() => csp.enforced.length).toBe(3);
      expect(csp.drain().map((v) => `${v.effectiveDirective} ${v.blockedURI}`)).toEqual(blocked.violations);
    } finally {
      await leaveAll(clients);
    }
  });
});
