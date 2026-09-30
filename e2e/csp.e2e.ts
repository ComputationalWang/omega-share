// Self-test for the zero-CSP-violation fixture (OME-191, threat model §8): enforced violations fail the test,
// report-only (Trusted Types) ones are only reported, and hand-made contexts are watched too.
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test, watchCsp } from "./support/csp";
import { joinRoom, leaveAll } from "./support/room";

const ENFORCED = `${URLS.fixtures}/__csp/enforced`;
const REPORT_ONLY = `${URLS.fixtures}/__csp/report-only`;
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
});
