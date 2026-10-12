import { describe, expect, test } from "bun:test";
import classic from "../../../assets/presets/classic.json";
import { pendingLayoutKey, stashPendingLayout, takePendingLayout } from "../src/pending-layout";

const ROOM = "abcdefghijklmnopqrstuvwxyz";

class MemoryStore {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, value: string): void {
    this.data.set(k, value);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

describe("pending layout (saved layout chosen at room creation)", () => {
  test("keyed per room in sessionStorage", () => {
    expect(pendingLayoutKey(ROOM)).toBe(`omega.pendingLayout.${ROOM}`);
  });

  test("a stashed layout is taken once, then it is gone", () => {
    const s = new MemoryStore();
    expect(stashPendingLayout(s, ROOM, classic)).toBe(true);
    expect(takePendingLayout(s, ROOM)).toEqual(classic);
    expect(s.data.size).toBe(0);
    expect(takePendingLayout(s, ROOM)).toBeNull();
  });

  test("nothing stashed, garbage and an invalid layout all read as null, and the key is cleared", () => {
    const s = new MemoryStore();
    expect(takePendingLayout(s, ROOM)).toBeNull();
    for (const raw of ["not json{", "{}", '{"furniture":[{"kind":"tv"}]}', "null"]) {
      s.data.set(pendingLayoutKey(ROOM), raw);
      expect(takePendingLayout(s, ROOM)).toBeNull();
      expect(s.data.size).toBe(0);
    }
  });

  test("a storage that throws never throws out of either call", () => {
    const boom = {
      getItem: (): string | null => {
        throw new Error("x");
      },
      setItem: (): void => {
        throw new Error("x");
      },
      removeItem: (): void => {
        throw new Error("x");
      },
    };
    expect(stashPendingLayout(boom, ROOM, classic)).toBe(false);
    expect(takePendingLayout(boom, ROOM)).toBeNull();
  });
});
