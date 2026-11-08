// lightningcss (Vite's CSS minifier) turns `border-image: none` into `border-image:`, an invalid declaration the browser
// drops, so the slice it meant to clear paints in the build (OME-2424: every name tag a blank plate). The dev server
// doesn't minify, so only this catches it: clear a slice with `border-image-source: none`.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const roots = [new URL("./", import.meta.url), new URL("../../../assets/ui/", import.meta.url)];

describe("shipped CSS", () => {
  test("never clears a slice with the `border-image: none` shorthand", async () => {
    const hits: string[] = [];
    for (const root of roots)
      for await (const file of new Glob("**/*.css").scan(root.pathname)) {
        const lines = (await Bun.file(new URL(file, root)).text()).split("\n");
        lines.forEach((line, i) => {
          if (/border-image\s*:\s*none\b/.test(line)) hits.push(`${file}:${String(i + 1)}`);
        });
      }
    expect(hits).toEqual([]);
  });
});
