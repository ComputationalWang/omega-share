import { describe, expect, test } from "bun:test";

// The invite key must be gone from location.href before any provider SDK can read it (ADR 0028, research §3.2):
// the Twitch SDK sends location.href to Twitch as `referrer`. Every SDK loads from the room chunk, which main.ts
// imports dynamically, so the strip has to run at module top level, before main.ts reaches any import().
const main = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();

describe("boot order (OME-409)", () => {
  test("main.ts strips #k= with takeInviteKey before any dynamic import", () => {
    const strip = main.indexOf("takeInviteKey(");
    const firstImport = main.search(/\bimport\(/);
    expect(strip).toBeGreaterThan(-1);
    expect(firstImport).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(firstImport);
  });

  test("the strip runs at top level, not inside a callback that could run late", () => {
    const line = main.split("\n").find((l) => l.includes("takeInviteKey("));
    expect(line).toMatch(/^(const \w+ = )?takeInviteKey\(/);
  });

  test("the key taken at boot reaches the join even when storage couldn't keep it", () => {
    const name = /const (\w+) = takeInviteKey\(/.exec(main)?.[1];
    expect(name).toBeDefined();
    expect(main).toMatch(new RegExp(`secretFor\\([^)]*, ${name ?? "?"}\\)`));
  });

  test("main.ts has no static import of a player or the room (those load provider SDKs)", () => {
    const statics = [...main.matchAll(/^import (?!type)[^;]*from "([^"]+)"/gm)].map((m) => m[1]);
    for (const s of statics) expect(s).not.toMatch(/player|\.\/room$|sdk/);
  });
});
