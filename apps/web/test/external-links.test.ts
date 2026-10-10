import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// Research §3.4 / S6: an outbound link must not hand a room URL to another site in its Referer.
describe("external links carry rel=noreferrer", () => {
  test("every <a> in the pages that leaves the site has rel noreferrer", async () => {
    for (const page of ["../index.html", "../privacy.html", "../terms.html", "../contact.html", "../licenses.html", "../chat.html", "../room.html"]) {
      const html = await Bun.file(new URL(page, import.meta.url)).text();
      for (const m of html.matchAll(/<a\s([^>]*)>/g)) {
        const attrs = m[1] ?? "";
        const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? "";
        if (href.startsWith("/") || href.startsWith("#")) continue;
        expect(`${page}: ${attrs}`).toMatch(/rel="[^"]*\bnoreferrer\b/);
      }
    }
  });

  test("no script under src/ builds an off-site link without noreferrer", async () => {
    const root = new URL("../src/", import.meta.url).pathname;
    for await (const f of new Glob("**/*.ts").scan(root)) {
      const src = await Bun.file(root + f).text();
      if (/target\s*[:=]\s*"_blank"/.test(src)) expect(`${f}: ${src}`).toMatch(/noreferrer/);
    }
  });
});
