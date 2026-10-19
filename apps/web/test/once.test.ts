// OME-1495: a chunk two callers ask for at once loads once, and both get the same thing; a failed load is forgotten.
import { describe, expect, test } from "bun:test";
import { onceAsync } from "../src/once";

describe("onceAsync", () => {
  test("two callers before the first load settles share one load and one result", async () => {
    let calls = 0;
    const get = onceAsync(async () => {
      calls++;
      await Promise.resolve();
      return { n: calls };
    });
    const [a, b] = await Promise.all([get(), get()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(await get()).toBe(a);
  });

  test("a failed load is forgotten, so the next call retries", async () => {
    let calls = 0;
    const get = onceAsync(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve("ok");
    });
    expect(await get().catch((e: unknown) => (e instanceof Error ? e.message : ""))).toBe("offline");
    expect(await get()).toBe("ok");
    expect(calls).toBe(2);
  });
});
