// Drift guard for the Unicode-dependent rules (nickname keys are persisted, so a Unicode move
// between Bun's ICU and the Rust crates must fail CI, not resume after a restart). For every code
// point U+0000..U+10FFFF except surrogates, one canonical line: the code point, its NFKC, NFC, NFD
// and lowercase forms, its nicknameKey, and 0/1 flags for each property the contract rules use.
// Lines are chunked per 0x1000 block and the SHA-256 of each chunk is the recorded decision, so a
// disagreeing chunk pinpoints the block. `tests/corpus.rs` builds the identical lines in Rust.
import { createHash } from "node:crypto";
import { nicknameKey } from "@omega/shared/confusables";
import type { Case } from "./corpora";

const PROPS = [
  /^\p{L}$/u,
  /^\p{M}$/u,
  /^\p{N}$/u,
  /^\p{P}$/u,
  /^\p{S}$/u,
  /^\p{Cc}$/u,
  /^\p{Cf}$/u,
  /^\p{Extended_Pictographic}$/u,
  /^\p{Script=Latin}$/u,
  /^[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]$/u,
  /^[\p{Lu}\p{Lt}]$/u,
];

const hex = (s: string): string => Array.from(s, (c) => (c.codePointAt(0) ?? 0).toString(16)).join(",");

export const CHUNK = 0x1000;

const line = (cp: number): string => {
  const c = String.fromCodePoint(cp);
  const flags = PROPS.map((re) => (re.test(c) ? "1" : "0")).join("");
  return `${cp.toString(16)}|${hex(c.normalize("NFKC"))}|${hex(c.normalize("NFC"))}|${hex(c.normalize("NFD"))}|${hex(c.toLowerCase())}|${hex(nicknameKey(c))}|${flags}\n`;
};

export const unicodeDigestCases = (): Case[] => {
  const cases: Case[] = [];
  for (let start = 0; start <= 0x10ffff; start += CHUNK) {
    const hash = createHash("sha256");
    for (let cp = start; cp < start + CHUNK && cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      hash.update(line(cp));
    }
    cases.push({ input: start.toString(16), ok: true, output: hash.digest("hex") });
  }
  return cases;
};
