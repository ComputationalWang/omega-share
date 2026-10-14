// The Valibot ↔ Rust comparison test (ADR 0050 §3). Each corpus runs inputs through the TS contract
// (`packages/shared`) and records what it decided; `apps/server-rs/tests/corpus.rs` runs the same inputs
// through the Rust contract and must decide the same. `corpus.test.ts` fails when a recorded file no
// longer matches the TS side, so a `packages/shared` change can't land without the Rust copy noticing:
// regenerate with `bun apps/server-rs/corpus/gen.ts`, then make the Rust tests pass.
import { normalizeHostname } from "@omega/shared";
import { embedCorpora } from "./embed-corpora";
import * as constants from "../../../packages/shared/src/constants";

/**
 * One decision: `ok` false means the TS side refused `input`; `output` is what it produced otherwise.
 * `rust: "refuses"` marks a deliberate difference (PORTING.md): Rust must refuse whatever TS decided.
 */
export interface Case {
  input: unknown;
  ok: boolean;
  output?: unknown;
  rust?: "refuses";
}

export interface Corpus {
  /** File name under `corpus/out/` (without `.json`); the Rust test loads the same name. */
  name: string;
  cases: () => Case[];
}

/** A pure TS function as a corpus: null means refused. */
export const decided = <I,>(inputs: readonly I[], run: (input: I) => unknown): Case[] =>
  inputs.map((input) => {
    const output = run(input);
    return output === null ? { input, ok: false } : { input, ok: true, output };
  });

/**
 * Raw JSON text, decided as the server sees it: `JSON.parse`, then `decide` (null means refused). The
 * only way to test what `JSON.stringify` never writes: `-0`, `1.0`, `1e2`, duplicate keys, the array
 * form of an object. Mark the deliberate differences `rustRefuses`.
 */
export interface RawInput {
  text: string;
  rustRefuses?: true;
}

export const decidedRaw = (inputs: readonly RawInput[], decide: (parsed: unknown) => unknown): Case[] =>
  inputs.map(({ text, rustRefuses }) => {
    let output: unknown = null;
    try {
      output = decide(JSON.parse(text));
    } catch {
      // Not JSON: refused, as the server's parse step does.
    }
    const decision: Case = output === null ? { input: text, ok: false } : { input: text, ok: true, output };
    return rustRefuses === true ? { ...decision, rust: "refuses" } : decision;
  });

const HOSTNAMES = [
  " Bad.Video.net. ",
  "evil.tv/path",
  "evil.tv:443",
  "user@evil.tv",
  "",
  "https://evil.tv",
  "münchen.de",
  "MÜNCHEN.DE",
  "a b",
  "1.2.3.4",
  "1.2.3",
  "999.1.1.1",
  "evil.tv..",
  "\uFEFFevil.tv",
  "\u0085evil.tv",
  " evil.tv\u3000",
  "EXAMPLE.com",
  "%41.com",
  "%zz.com",
  "xn--mnchen-3ya.de",
  "xn--zz.de",
  "ex_ample.com",
  "a..b",
  ".",
  "..",
  "0x7f.1",
  "[::1]",
  "exa\tmple.com",
  "faß.de",
  "😀.com",
  "\uFB01.com",
  "\u24B6.com",
  "a\u200Db.com",
  "a\u00ADb.com",
  " a.com",
  "a.com\\",
  "a-.com",
  "-a.com",
  "a".repeat(63) + ".com",
  "a".repeat(64) + ".com",
  "localhost",
];

/** Every exported constant by name (`CLOSE_CODES.X` as `close.X`): the Rust module must have each, equal. */
const constantCases = (): Case[] =>
  Object.entries(constants).flatMap(([name, value]): Case[] =>
    typeof value === "object"
      ? Object.entries(value).map(([code, n]) => ({ input: `close.${code}`, ok: true, output: n }))
      : [{ input: name, ok: true, output: value }],
  );

/** Every corpus; add a line when a slice ports a schema or function. */
export const corpora: Corpus[] = [
  { name: "normalize-hostname", cases: () => decided(HOSTNAMES, normalizeHostname) },
  { name: "constants", cases: constantCases },
  ...embedCorpora,
];

/** One case per line, so a changed decision shows as a one-line diff. */
export const render = (cases: readonly Case[]): string => `[\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`;

export const outPath = (name: string): URL => new URL(`out/${name}.json`, import.meta.url);
