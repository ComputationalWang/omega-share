import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { CONFUSABLES_VERSION } from "../../../packages/shared/src/confusables-table";
import { confusablesPath, confusablesTxt, corpora, outPath, render } from "./corpora";

// unicode-digest.json takes about 5 s on a loaded CI runner: past bun's 5 s default it failed PRs at random.
setDefaultTimeout(30_000);

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

  test("confusables.txt is the TS table (Rust include_str!)", () => {
    expect(readFileSync(confusablesPath, "utf8")).toBe(confusablesTxt);
  });

  test("Unicode versions: table 18.0.0, Bun's ICU 17 (pinned in confusables.rs too)", () => {
    expect(CONFUSABLES_VERSION).toBe("18.0.0");
    expect(process.versions["unicode"]).toBe("17.0");
  });

  test("corpus names are unique", () => {
    const names = corpora.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
