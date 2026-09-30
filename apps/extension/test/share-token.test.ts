import { describe, expect, test } from "bun:test";
import { MAX_RECORD_LENGTH, readRecordInPage, readShareTokens, roomTabPatterns, type TokenDeps } from "../src/share-token";

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const TOKEN2 = "abcdefghijklmnopqrstuv";
const record = (roomId: string, token: string): string => JSON.stringify({ roomId, token });

function fake(tabs: Record<number, unknown>, opts: { failing?: readonly number[] } = {}): { deps: TokenDeps; queried: string[][]; read: number[] } {
  const queried: string[][] = [];
  const read: number[] = [];
  return {
    queried,
    read,
    deps: {
      queryTabs: (patterns) => {
        queried.push([...patterns]);
        return Promise.resolve([...Object.keys(tabs).map((id) => ({ id: Number(id) })), {}]);
      },
      readSession: (tabId) => {
        read.push(tabId);
        if (opts.failing?.includes(tabId) === true) return Promise.reject(new Error("tab discarded"));
        return Promise.resolve(tabs[tabId]);
      },
    },
  };
}

describe("roomTabPatterns", () => {
  test("a tunnel origin: its room pages only", () => {
    expect(roomTabPatterns("https://abc123.ngrok-free.app")).toEqual(["https://abc123.ngrok-free.app/r/*"]);
  });
  test("a loopback server: room pages on any local port (the dev site runs beside the server)", () => {
    expect(roomTabPatterns("http://localhost:8787")).toEqual(["http://localhost/r/*", "http://127.0.0.1/r/*", "http://[::1]/r/*"]);
    expect(roomTabPatterns("http://127.0.0.1:3000")).toEqual(["http://localhost/r/*", "http://127.0.0.1/r/*", "http://[::1]/r/*"]);
  });
});

describe("readShareTokens", () => {
  test("queries room tabs and parses each tab's sessionStorage record", async () => {
    const f = fake({ 4: record("lobby", TOKEN), 9: record("movies", TOKEN2) });
    const tokens = await readShareTokens("https://abc123.ngrok-free.app", f.deps);
    expect([...tokens]).toEqual([
      ["lobby", TOKEN],
      ["movies", TOKEN2],
    ]);
    expect(f.queried).toEqual([["https://abc123.ngrok-free.app/r/*"]]);
  });

  const hostile: readonly [string, unknown][] = [
    ["no record", null],
    ["a non-string", 42],
    ["an object instead of JSON text", { roomId: "lobby", token: TOKEN }],
    ["broken JSON", "{roomId:"],
    ["a short token", record("lobby", "short")],
    ["a padded token", record("lobby", `${TOKEN.slice(0, 20)}==`)],
    ["a bad room id", record("../admin", TOKEN)],
    ["an extra key", JSON.stringify({ roomId: "lobby", token: TOKEN, admin: true })],
    ["an oversized record", `${record("lobby", TOKEN)}${" ".repeat(10_000)}`],
  ];
  for (const [name, value] of hostile) {
    test(`ignores ${name}`, async () => {
      expect((await readShareTokens("http://localhost:8787", fake({ 1: value }).deps)).size).toBe(0);
    });
  }

  test("a tab that can't be read is skipped, the others still count", async () => {
    const f = fake({ 1: record("lobby", TOKEN), 2: record("movies", TOKEN2) }, { failing: [1] });
    expect([...(await readShareTokens("http://localhost:8787", f.deps))]).toEqual([["movies", TOKEN2]]);
  });

  test("the first tab of a room wins", async () => {
    const f = fake({ 1: record("lobby", TOKEN), 2: record("lobby", TOKEN2) });
    expect((await readShareTokens("http://localhost:8787", f.deps)).get("lobby")).toBe(TOKEN);
  });

  test("reads at most 8 tabs", async () => {
    const tabs: Record<number, unknown> = {};
    for (let i = 1; i <= 20; i++) tabs[i] = record(`room-${String(i)}`, TOKEN);
    const f = fake(tabs);
    await readShareTokens("http://localhost:8787", f.deps);
    expect(f.read.length).toBe(8);
  });

  test("a failed tab query yields no tokens, never a throw", async () => {
    const tokens = await readShareTokens("http://localhost:8787", {
      queryTabs: () => Promise.reject(new Error("no permission")),
      readSession: () => Promise.resolve(null),
    });
    expect(tokens.size).toBe(0);
  });
});

describe("readRecordInPage (runs inside the room tab)", () => {
  const storage = (value: string | null): Pick<Storage, "getItem"> => ({ getItem: (key) => (key === "omega.share" ? value : null) });

  test("returns the record under the key", () => {
    expect(readRecordInPage("omega.share", MAX_RECORD_LENGTH, storage(record("lobby", TOKEN)))).toBe(record("lobby", TOKEN));
  });
  test("a missing record is null", () => {
    expect(readRecordInPage("omega.share", MAX_RECORD_LENGTH, storage(null))).toBeNull();
  });
  test("a record at the cap is returned; one past it never leaves the page", () => {
    expect(readRecordInPage("omega.share", 512, storage("x".repeat(512)))).toBe("x".repeat(512));
    expect(readRecordInPage("omega.share", 512, storage("x".repeat(513)))).toBeNull();
    expect(readRecordInPage("omega.share", 512, storage("x".repeat(5_000_000)))).toBeNull();
  });
  test("the cap is 512", () => {
    expect(MAX_RECORD_LENGTH).toBe(512);
  });
});
