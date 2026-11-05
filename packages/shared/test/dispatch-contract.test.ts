import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ServerMessageSchema, parseServerMessage } from "../src/index";
import corpus from "../../../apps/server-rs/corpus/out/server-message-raw.json";

// parseServerMessage picks the option by `type` instead of running every earlier option's literal (OME-2224):
// each miss in a `variant` allocates an issue, and a `walked` frame (or each message in a `batch`) paid for them all.

const Case = v.object({ input: v.string(), ok: v.boolean(), output: v.optional(v.unknown()) });
const cases = v.parse(v.array(Case), corpus);

describe("server message dispatch", () => {
  test("every server-message corpus frame parses to the corpus result", () => {
    expect(cases.length).toBeGreaterThan(1000);
    // Through JSON like the corpus itself, so `-0` reads as `0`.
    const json = (x: unknown): unknown => JSON.parse(JSON.stringify(x));
    for (const c of cases) expect({ input: c.input, out: json(parseServerMessage(c.input)) }).toEqual({ input: c.input, out: c.ok ? c.output : null });
  });

  test("an unknown type, a missing type and a wrong shape are null", () => {
    for (const raw of ['{"type":"nope"}', '{"memberId":"m1"}', "[]", "1", "null", '{"type":"walked","memberId":"a b","cell":{"x":1,"y":2}}', '{"type":"batch","msgs":[{"type":"nope"}]}'])
      expect(parseServerMessage(raw)).toBeNull();
  });

  test("a walked frame, alone or batched, never checks an earlier option's type", () => {
    const literal = ServerMessageSchema.options[0].entries.type;
    const run = literal["~run"];
    const first: { "~run": typeof run } = literal; // a writable view, to count the calls
    let calls = 0;
    first["~run"] = (dataset, config) => {
      calls++;
      return run.call(literal, dataset, config);
    };
    try {
      const walked = { type: "walked", memberId: "m1", cell: { x: 1, y: 2 } } as const;
      expect(parseServerMessage(JSON.stringify(walked))).toEqual(walked);
      expect(parseServerMessage(JSON.stringify({ type: "batch", msgs: [walked, walked] }))).toEqual({ type: "batch", msgs: [walked, walked] });
    } finally {
      first["~run"] = run;
    }
    expect(calls).toBe(0);
  });
});
