import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { corpora, outPath, render } from "./corpora";

// The recorded decisions are what the Rust contract is tested against (tests/corpus.rs). If the TS
// contract changed, regenerate (`bun apps/server-rs/corpus/gen.ts`) and bring the Rust side along.
describe("Valibot ↔ Rust corpus (ADR 0050 §3)", () => {
  for (const corpus of corpora) {
    test(`${corpus.name}.json is what the TS contract decides today`, () => {
      const path = outPath(corpus.name);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(render(corpus.cases()));
    });
  }

  test("corpus names are unique", () => {
    const names = corpora.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
