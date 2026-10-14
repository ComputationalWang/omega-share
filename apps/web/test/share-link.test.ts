import { describe, expect, test } from "bun:test";
import { MAX_URL_LENGTH } from "@omega/shared";
import { takeShareLink } from "../src/share-link";

// The extension's hand-off (OME-1085, ADR 0049): `/#share=<encodeURIComponent(url)>`. Taken once at boot and dropped
// from the URL; only the home chunk parses it (pending-layout.ts `shareableLink`).

function page(url: string) {
  const u = new URL(url);
  const calls: string[] = [];
  const loc = {
    get pathname() {
      return u.pathname;
    },
    get search() {
      return u.search;
    },
    get hash() {
      return u.hash;
    },
  };
  const history = {
    state: { kept: true } as unknown,
    replaceState(_data: unknown, _unused: string, next: string): void {
      calls.push(next);
      const n = new URL(next, u);
      u.pathname = n.pathname;
      u.search = n.search;
      u.hash = n.hash;
    },
  };
  return { loc, history, calls };
}

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10";

describe("takeShareLink: the #share= fragment is read once and dropped at boot", () => {
  test("returns the decoded link and drops the fragment, keeping path and query", () => {
    const p = page(`https://omega.example/?x=1#share=${encodeURIComponent(YT)}`);
    expect(takeShareLink(p.loc, p.history)).toBe(YT);
    expect(p.calls).toEqual(["/?x=1"]);
    expect(p.loc.hash).toBe("");
  });

  test("malformed encoding, empty and oversized values are dropped too, and nothing is returned", () => {
    const huge = encodeURIComponent(`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`);
    for (const hash of ["#share=%E0%A4%A", "#share=", `#share=${huge}`]) {
      const p = page(`https://omega.example/${hash}`);
      expect(takeShareLink(p.loc, p.history)).toBeNull();
      expect(p.loc.hash).toBe("");
    }
  });

  test("no fragment, or another one (an invite key), leaves the URL alone", () => {
    for (const url of ["https://omega.example/", "https://omega.example/#top", "https://omega.example/r/abc#k=x"]) {
      const p = page(url);
      expect(takeShareLink(p.loc, p.history)).toBeNull();
      expect(p.calls).toEqual([]);
    }
  });
});
