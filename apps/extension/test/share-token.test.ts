import { describe, expect, test } from "bun:test";
import { MAX_RECORD_LENGTH, readRecordInPage, readShareTokens, roomTabPatterns, type TokenDeps } from "../src/share-token";

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const TOKEN2 = "abcdefghijklmnopqrstuv";
const record = (roomId: string, token: string): string => JSON.stringify({ roomId, token });

interface FakeTab {
  readonly url?: string;
  readonly value: unknown;
}

/** A room tab at `/r/<roomId>` holding `value` (by default, that room's well-formed record). */
const at = (roomId: string, value: unknown = record(roomId, TOKEN)): FakeTab => ({ url: `http://localhost:5173/r/${roomId}`, value });

function fake(tabs: Record<number, FakeTab>, opts: { failing?: readonly number[] } = {}): { deps: TokenDeps; queried: string[][]; read: number[] } {
  const queried: string[][] = [];
  const read: number[] = [];
  return {
    queried,
    read,
    deps: {
      queryTabs: (patterns) => {
        queried.push([...patterns]);
        return Promise.resolve([...Object.entries(tabs).map(([id, t]) => ({ id: Number(id), url: t.url })), {}]);
      },
      readSession: (tabId) => {
        read.push(tabId);
        if (opts.failing?.includes(tabId) === true) return Promise.reject(new Error("tab discarded"));
        return Promise.resolve(tabs[tabId]?.value);
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
    const f = fake({ 4: at("lobby"), 9: at("movies", record("movies", TOKEN2)) });
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
      expect((await readShareTokens("http://localhost:8787", fake({ 1: at("lobby", value) }).deps)).size).toBe(0);
    });
  }

  test("a tab that can't be read is skipped, the others still count", async () => {
    const f = fake({ 1: at("lobby"), 2: at("movies", record("movies", TOKEN2)) }, { failing: [1] });
    expect([...(await readShareTokens("http://localhost:8787", f.deps))]).toEqual([["movies", TOKEN2]]);
  });

  test("the first tab of a room wins", async () => {
    const f = fake({ 1: at("lobby"), 2: at("lobby", record("lobby", TOKEN2)) });
    expect((await readShareTokens("http://localhost:8787", f.deps)).get("lobby")).toBe(TOKEN);
  });

  test("reads at most 8 tabs", async () => {
    const tabs: Record<number, FakeTab> = {};
    for (let i = 1; i <= 20; i++) tabs[i] = at(`room-${String(i)}`);
    const f = fake(tabs);
    await readShareTokens("http://localhost:8787", f.deps);
    expect(f.read.length).toBe(8);
  });

  test("a record for another room than its tab's /r/<id> is ignored and can't shadow the real room", async () => {
    // Any local page under /r/* can plant a well-formed record (ADR 0015); it only counts for its own room.
    const f = fake({ 1: at("movies", record("lobby", TOKEN2)), 2: at("lobby") });
    expect([...(await readShareTokens("http://localhost:8787", f.deps))]).toEqual([["lobby", TOKEN]]);
  });

  const roomUrls: readonly [string, string | undefined, string | null][] = [
    ["a trailing slash", "http://localhost:5173/r/lobby/", "lobby"],
    ["a query and hash", "https://abc123.ngrok-free.app/r/lobby?x=1#y", "lobby"],
    ["a deeper path", "http://localhost:5173/r/lobby/extra", null],
    ["an empty room segment", "http://localhost:5173/r/", null],
    ["an invalid room id", "http://localhost:5173/r/Lobby", null],
    ["an encoded room id", "http://localhost:5173/r/lob%62y", null],
    ["no URL (no host permission)", undefined, null],
    ["an unparsable URL", "not a url", null],
  ];
  for (const [name, url, expected] of roomUrls) {
    test(`a tab URL with ${name} binds ${expected ?? "no room"}`, async () => {
      const f = fake({ 1: { url, value: record("lobby", TOKEN) } });
      const tokens = await readShareTokens("http://localhost:8787", f.deps);
      expect([...tokens.keys()]).toEqual(expected === null ? [] : [expected]);
      // A tab with no room in its URL is never injected into.
      expect(f.read).toEqual(expected === null ? [] : [1]);
    });
  }

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
