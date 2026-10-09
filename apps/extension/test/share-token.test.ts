import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_RECORD_LENGTH, readRecordInPage, readRoomTabs, roomTabPatterns, type TokenDeps } from "../src/share-token";

const readShareTokens = async (origin: string, deps: TokenDeps) => (await readRoomTabs(origin, deps)).tokens;

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const TOKEN2 = "abcdefghijklmnopqrstuv";
const record = (roomId: string, token: string): string => JSON.stringify({ roomId, token });

interface FakeTab {
  readonly url?: string | undefined;
  readonly value: unknown;
}

/** A room tab at `/r/<roomId>` holding `value` (by default, that room's well-formed record). */
const at = (roomId: string, value: unknown = record(roomId, TOKEN), site = "http://localhost:5173"): FakeTab => ({ url: `${site}/r/${roomId}`, value });

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
      inject: (tabId) => {
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
    // Firefox never matches a pattern with a port (QA OME-687); a port-less one matches the room tab on any port.
    expect(roomTabPatterns("https://qa682.test:8968")).toEqual(["https://qa682.test/r/*"]);
  });
  test("a loopback server: room pages on any local port (the dev site runs beside the server)", () => {
    expect(roomTabPatterns("http://localhost:8787")).toEqual(["http://localhost/r/*", "http://127.0.0.1/r/*", "http://[::1]/r/*"]);
    expect(roomTabPatterns("http://127.0.0.1:3000")).toEqual(["http://localhost/r/*", "http://127.0.0.1/r/*", "http://[::1]/r/*"]);
  });
});

describe("readShareTokens", () => {
  test("queries room tabs and parses each tab's sessionStorage record", async () => {
    const site = "https://abc123.ngrok-free.app";
    const f = fake({ 4: at("lobby", record("lobby", TOKEN), site), 9: at("movies", record("movies", TOKEN2), site) });
    const tokens = await readShareTokens(site, f.deps);
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
      inject: () => Promise.resolve(null),
    });
    expect(tokens.size).toBe(0);
  });
});

describe("readRoomTabs: rooms open in the user's site tabs (threat model §3.5)", () => {
  test("every open room tab's room is listed in tab order, with or without a share token, once each", async () => {
    // A private room never appears in GET /rooms; its open tab is how the user can still share into it.
    const f = fake({ 3: at("abcdefghijklmnopqrstuvwxyz", null), 4: at("lobby"), 5: at("abcdefghijklmnopqrstuvwxyz") });
    const tabs = await readRoomTabs("http://localhost:8787", f.deps);
    expect(tabs.rooms).toEqual(["abcdefghijklmnopqrstuvwxyz", "lobby"]);
    expect([...tabs.tokens]).toEqual([
      ["lobby", TOKEN],
      ["abcdefghijklmnopqrstuvwxyz", TOKEN],
    ]);
  });

  test("tabs whose URL is not a room page add no room", async () => {
    const f = fake({ 1: { url: "http://localhost:5173/r/Lobby", value: null }, 2: { url: undefined, value: null } });
    expect((await readRoomTabs("http://localhost:8787", f.deps)).rooms).toEqual([]);
  });

  test("rooms come from tab URLs, so tabs past the 8 injected still list their room", async () => {
    const tabs: Record<number, FakeTab> = {};
    for (let i = 1; i <= 12; i++) tabs[i] = at(`room-${String(i)}`);
    const f = fake(tabs);
    expect((await readRoomTabs("http://localhost:8787", f.deps)).rooms).toHaveLength(12);
    expect(f.read).toHaveLength(8);
  });

  test("an https server: tabs on another port of its host are ignored, its own origin's tabs are kept (QA OME-689)", async () => {
    // The port-less pattern matches every port of the host; another site there could plant a record.
    const f = fake({
      1: { url: "https://qa682.test:9999/r/other", value: record("other", TOKEN) },
      2: { url: "https://qa682.test/r/other", value: record("other", TOKEN) },
      3: { url: "https://qa682.test:8443/r/lobby", value: record("lobby", TOKEN2) },
    });
    const tabs = await readRoomTabs("https://qa682.test:8443", f.deps);
    expect(tabs.rooms).toEqual(["lobby"]);
    expect([...tabs.tokens]).toEqual([["lobby", TOKEN2]]);
    expect(f.read).toEqual([3]);
  });

  test("a loopback server still lists room tabs on any local port", async () => {
    const f = fake({ 1: { url: "http://127.0.0.1:5173/r/lobby", value: null }, 2: { url: "http://[::1]:4000/r/movies", value: null } });
    expect((await readRoomTabs("http://localhost:8787", f.deps)).rooms).toEqual(["lobby", "movies"]);
  });

  test("a failed tab query lists no rooms, never a throw", async () => {
    const tabs = await readRoomTabs("http://localhost:8787", { queryTabs: () => Promise.reject(new Error("x")), inject: () => Promise.resolve(null) });
    expect(tabs.rooms).toEqual([]);
  });
});

describe("never reads the site's owner tokens or invite keys (ADR 0028, threat model S3)", () => {
  const realLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const realSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  afterEach(() => {
    for (const [name, d] of [["localStorage", realLocal], ["sessionStorage", realSession]] as const) {
      if (d === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, d);
    }
  });

  /** A room tab's storage holding both the share record and the site's room secrets; every access is logged. */
  function spyStorage(log: string[], area: string, items: Record<string, string>): Storage {
    return new Proxy({} as Storage, {
      get: (_, prop) => {
        log.push(`${area}.${String(prop)}`);
        if (prop === "getItem") return (key: string) => (log.push(`${area}.getItem(${key})`), items[key] ?? null);
        return undefined;
      },
    });
  }

  test("the script injected into a room tab touches sessionStorage['omega.share'] only, never localStorage", async () => {
    const log: string[] = [];
    const secrets = JSON.stringify({ lobby: { ownerToken: "o".repeat(43), inviteKey: "k".repeat(22) } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: spyStorage(log, "localStorage", { "omega.rooms": secrets }) });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: spyStorage(log, "sessionStorage", { "omega.share": record("lobby", TOKEN), "omega.rooms": secrets }),
    });
    const injected: unknown[][] = [];
    const tabs = await readRoomTabs("http://localhost:8787", {
      queryTabs: () => Promise.resolve([{ id: 1, url: "http://localhost:5173/r/lobby" }]),
      // Runs the injected function here, against the spied storages, as executeScript would in the tab.
      inject: (_tabId, func, args) => {
        injected.push([...args]);
        return Promise.resolve(func(...args));
      },
    });
    expect(tabs.tokens.get("lobby")).toBe(TOKEN);
    expect(injected).toEqual([["omega.share", MAX_RECORD_LENGTH]]);
    expect(log.filter((l) => l.includes("(")).sort()).toEqual(["sessionStorage.getItem(omega.share)"]);
    expect(log.some((l) => l.startsWith("localStorage"))).toBe(false);
  });

  test("no extension source names the room secrets key, localStorage, an owner token or an invite key", () => {
    const src = join(import.meta.dir, "../src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => /\.(ts|html)$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    const forbidden = /omega\.rooms|ROOM_SECRETS_STORAGE_KEY|RoomSecrets|localStorage|ownerToken|OwnerToken|inviteKey|InviteKey/;
    expect(files.filter((f) => forbidden.test(readFileSync(join(src, f), "utf8")))).toEqual([]);
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
