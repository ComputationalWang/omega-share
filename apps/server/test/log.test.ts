import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";
import { formatLogLine, logError } from "../src/log";
import { Client, start, type TestServer } from "./helpers";
import type { RoomPersistence } from "../src/server";

function vError(f: () => unknown): Error {
  try {
    f();
  } catch (err) {
    if (err instanceof Error) return err;
  }
  throw new Error("expected an Error");
}

const parse = (line: string) => JSON.parse(line) as { level?: string; event?: string; error?: string };

// OME-504: error lines go to stderr (journald on the box) and carry no personal data.
describe("logger", () => {
  test("a line is one JSON object: level, a fixed event name and the error's class", () => {
    const line = formatLogLine("error", "store.last_active", new TypeError("boom"));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ level: "error", event: "store.last_active", error: "TypeError: boom" });
  });

  test("redacts quoted values, addresses and emails from error messages", () => {
    const err = new Error('write failed from 203.0.113.7, [2001:db8::1]:443 or fe80::1 by mail@example.com: no room "secret-room-id": "My Private Title"');
    const line = formatLogLine("error", "store.title", err);
    for (const secret of ["secret-room-id", "My Private Title", "203.0.113.7", "2001:db8::1", "fe80::1", "mail@example.com"]) {
      expect(line).not.toContain(secret);
    }
    expect(parse(line).error).toBe('Error: write failed from <ip>, [<ip>]:443 or <ip> by <email>: no room "…"');
  });

  // OME-536: a quoted value may itself hold a quote, escaped (JSON.stringify) or not (Valibot), so the
  // scrub over-redacts: everything from the first quote to the end of the message goes.
  test("a quoted value holding a quote leaks none of its characters", () => {
    const cases: [Error, string][] = [
      [vError(() => v.parse(v.number(), 'Ali"ce Secret')), 'ValiError: Invalid type: Expected number but received "…"'],
      [vError(() => v.parse(v.number(), "Ali'ce Secret")), 'ValiError: Invalid type: Expected number but received "…"'],
      [new Error(`Room ${JSON.stringify('Ali"ceSecretNick')} not found`), 'Error: Room "…"'],
      [new Error("no room 'Ali'ce Secret' here"), "Error: no room '…'"],
    ];
    for (const [err, expected] of cases) {
      const line = formatLogLine("error", "store.title", err);
      for (const secret of ["Ali", "ce Secret", "ceSecret", "Secret", "Nick", "here"]) expect(line).not.toContain(secret);
      expect(parse(line).error).toBe(expected);
    }
  });

  test("a quoted value cut off by the length cap is still redacted", () => {
    const line = formatLogLine("error", "store.title", new Error(`no room "${"s".repeat(300)}"`));
    expect(line).not.toContain("sss");
    expect(parse(line).error).toBe('Error: no room "…"');
  });

  // OME-548: the cap runs last, so an address that straddles it is not cut to a fragment the patterns miss.
  test("an IP or email straddling the length cap is still redacted", () => {
    const pad = `${"x".repeat(225)} from `;
    const cases: [string, string, string[]][] = [
      [`${pad}203.0.113.7`, `Error: ${pad}<ip>`, ["203", "113"]],
      [`${pad}mail@example.com`, `Error: ${pad}<email>`, ["mail@", "exam"]],
      [`${pad}2001:db8:85a3::8a2e:370:7334`, `Error: ${pad}<ip>`, ["2001", "db8", "85a3"]],
    ];
    for (const [message, expected, secrets] of cases) {
      const line = formatLogLine("error", "store.title", new Error(message));
      for (const secret of secrets) expect(line).not.toContain(secret);
      expect(parse(line).error).toBe(expected);
    }
  });

  test("caps the message length", () => {
    const line = formatLogLine("error", "store.title", new Error("x".repeat(5000)));
    expect(line.length).toBeLessThan(400);
  });

  test("a non-Error value is logged by type only", () => {
    expect(parse(formatLogLine("error", "gc.sweep", "alice at 10.0.0.1")).error).toBe("non-Error string");
  });

  test("logError writes one line to stderr", () => {
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      logError("gc.sweep", new Error("x"));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual([formatLogLine("error", "gc.sweep", new Error("x"))]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("server error lines", () => {
  let t: TestServer | null = null;
  afterEach(() => {
    void t?.server.stop(true);
    t = null;
  });

  test("a failed store write logs no room id or nickname", async () => {
    const roomId = "private-room-xyz";
    const store: RoomPersistence = {
      listRooms: () => [],
      createRoom: () => undefined,
      deleteRoom: () => true,
      setEmbed: () => undefined,
      setLayout: () => undefined,
      setTitle: () => undefined,
      setControlPolicy: () => undefined,
      setLastActive: (id) => {
        throw new Error(`no room ${JSON.stringify(id)}`);
      },
    };
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      t = start({ store, rooms: [roomId] });
      const { client } = await Client.join(t.ws(roomId), "nick-in-log");
      client.close();
      await client.closed;
      await Bun.sleep(20);
      const lines = spy.mock.calls.map((c) => c.map(String).join(" "));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain(roomId);
        expect(line).not.toContain("nick-in-log");
        expect(parse(line).event).toBe("store.last_active");
      }
    } finally {
      spy.mockRestore();
    }
  });
});
