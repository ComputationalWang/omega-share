import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { findHtmlSinks } from "./support/html-sinks";

describe("findHtmlSinks", () => {
  test("catches every banned sink in a planted sample", () => {
    const sample = [
      "el.innerHTML = x;",
      "el.outerHTML = x;",
      "el.insertAdjacentHTML('beforeend', x);",
      "document.write(x);",
      "new DOMParser().parseFromString(x, 'text/html');",
      "range.createContextualFragment(x);",
      "frame.srcdoc = x;",
    ].join("\n");
    expect(findHtmlSinks(sample).sort()).toEqual(
      ["DOMParser", "createContextualFragment", "document.write", "innerHTML", "insertAdjacentHTML", "outerHTML", "srcdoc"].sort(),
    );
  });
  test("ignores clean code", () => {
    expect(findHtmlSinks("el.textContent = x; const s = 'safe';")).toEqual([]);
  });
});

describe("apps/web has no HTML sinks", () => {
  test("no file under src/ uses one", async () => {
    const root = new URL("../src/", import.meta.url).pathname;
    const offenders: string[] = [];
    let files = 0;
    for await (const rel of new Glob("**/*.ts").scan(root)) {
      files++;
      const hits = findHtmlSinks(await Bun.file(root + rel).text());
      if (hits.length > 0) offenders.push(`${rel}: ${hits.join(", ")}`);
    }
    expect(files).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
  test("index.html has no inline script and no sink", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(findHtmlSinks(html)).toEqual([]);
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) expect(m[1]).toMatch(/\bsrc=/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});
