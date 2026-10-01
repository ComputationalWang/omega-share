import { describe, expect, test } from "bun:test";
import { REPO_URL, sourceUrl, withSourceLink } from "../source";

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

/** The footer's Source anchor as the browser would see it after the build/dev transform. */
function sourceAnchor(page: string): Record<string, string> {
  const m = /<footer[^>]*>[\s\S]*?<a ([^>]*data-testid="source-link"[^>]*)>Source<\/a>[\s\S]*?<\/footer>/.exec(page);
  if (m?.[1] === undefined) throw new Error("no Source link in the footer");
  return Object.fromEntries([...m[1].matchAll(/([a-z-]+)="([^"]*)"/g)].map((a) => [a[1] ?? "", a[2] ?? ""]));
}

describe("AGPL-3.0 §13 Source link (OME-272)", () => {
  test("the footer links to the public repository in a new tab, without opener or referrer", () => {
    const a = sourceAnchor(withSourceLink(html, sourceUrl(undefined)));
    expect(a["href"]).toBe("https://github.com/ComputationalWang/omega-share");
    expect(a["target"]).toBe("_blank");
    expect(a["rel"]?.split(" ").sort()).toEqual(["noopener", "noreferrer"]);
  });

  test("a fork can point it at its own source with VITE_SOURCE_URL", () => {
    const a = sourceAnchor(withSourceLink(html, sourceUrl("https://git.example.org/me/my-fork")));
    expect(a["href"]).toBe("https://git.example.org/me/my-fork");
  });

  test("anything but a plain https URL falls back to the repository", () => {
    for (const bad of ["", "javascript:alert(1)", "http://example.org/src", "not a url", "https://user:pw@example.org/"]) {
      expect(sourceUrl(bad)).toBe(REPO_URL);
    }
  });

  test("the configured URL can't break out of the href attribute", () => {
    const a = sourceAnchor(withSourceLink(html, sourceUrl(`https://example.org/a"onclick="x'<b>`)));
    expect(a["onclick"]).toBeUndefined();
    expect(a["href"]).toStartWith("https://example.org/a");
  });

  test("index.html never ships an untransformed placeholder", () => {
    expect(withSourceLink(html, REPO_URL)).not.toContain("%OMEGA_SOURCE_URL%");
  });
});
