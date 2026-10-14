// Writes every corpus to `corpus/out/` (ADR 0050 §3): `bun apps/server-rs/corpus/gen.ts`.
import { writeFileSync } from "node:fs";
import { corpora, outPath, render } from "./corpora";

for (const corpus of corpora) {
  const cases = corpus.cases();
  writeFileSync(outPath(corpus.name), render(cases));
  console.log(`${corpus.name}: ${String(cases.length)} cases`);
}
