import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { SHARE_TOKEN_STORAGE_KEY, ShareTokenRecordSchema, type RoomState, type ServerMessage } from "@omega/shared";
import { serverBaseUrl, wsUrl } from "../src/route";
import { trackShareToken, type ShareTokenStorage } from "../src/share-token";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const ROOM: RoomState = { id: "lobby", members: [], seats: [null, null, null, null, null, null, null, null], embed: null, playback: null };

class MemoryStorage implements ShareTokenStorage {
  readonly items = new Map<string, string>();
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}
const message = (msg: ServerMessage) => ({ type: "message", msg }) as const;
const snapshot = (shareToken?: string): ServerMessage =>
  shareToken === undefined ? { type: "snapshot", self: "me", room: ROOM } : { type: "snapshot", self: "me", room: ROOM, shareToken };

describe("serverBaseUrl (ADR 0015 §1)", () => {
  test("a built site talks to its own origin, so one tunnel covers site, API and WebSocket", () => {
    const base = serverBaseUrl(undefined, { origin: "https://quiet-otter.ngrok-free.app", protocol: "https:", hostname: "quiet-otter.ngrok-free.app" }, false);
    expect(base).toBe("https://quiet-otter.ngrok-free.app");
    // T-12: wss follows from https, so there is no mixed content.
    expect(wsUrl(base, "lobby")).toBe("wss://quiet-otter.ngrok-free.app/rooms/lobby/ws");
  });

  test("the dev site keeps talking to port 8787 on its own host (localhost dev unchanged)", () => {
    expect(serverBaseUrl(undefined, { origin: "http://localhost:5173", protocol: "http:", hostname: "localhost" }, true)).toBe(
      "http://localhost:8787",
    );
  });

  test("VITE_SERVER_URL wins in both (e2e, perf)", () => {
    const loc = { origin: "http://localhost:4173", protocol: "http:", hostname: "localhost" };
    expect(serverBaseUrl("http://localhost:8788", loc, false)).toBe("http://localhost:8788");
    expect(serverBaseUrl("http://localhost:8788", loc, true)).toBe("http://localhost:8788");
  });
});

describe("trackShareToken (ADR 0015 §7)", () => {
  const record = (s: MemoryStorage) => {
    const raw = s.items.get(SHARE_TOKEN_STORAGE_KEY);
    return raw === undefined ? null : v.parse(ShareTokenRecordSchema, JSON.parse(raw));
  };

  test("a snapshot's token is stored for the extension as { roomId, token }", () => {
    const s = new MemoryStorage();
    trackShareToken(s, "lobby").onEvent(message(snapshot(TOKEN)));
    expect(record(s)).toEqual({ roomId: "lobby", token: TOKEN });
  });

  test("a snapshot without a token (pre-M2 server) leaves no record", () => {
    const s = new MemoryStorage();
    const t = trackShareToken(s, "lobby");
    t.onEvent(message(snapshot(TOKEN)));
    t.onEvent(message(snapshot()));
    expect(record(s)).toBeNull();
  });

  test("room-full, a drop and close clear it: the server has revoked the token", () => {
    for (const end of ["room-full", "disconnected", "close"] as const) {
      const s = new MemoryStorage();
      const t = trackShareToken(s, "lobby");
      t.onEvent(message(snapshot(TOKEN)));
      if (end === "close") t.clear();
      else t.onEvent(end === "room-full" ? message({ type: "room-full" }) : { type: "disconnected" });
      expect(record(s)).toBeNull();
    }
  });

  test("a kick (4005) or a closed room (4004) clears it too: the server dropped the member", () => {
    for (const end of [{ type: "kicked", wasIn: true }, { type: "room-closed" }] as const) {
      const s = new MemoryStorage();
      const t = trackShareToken(s, "lobby");
      t.onEvent(message(snapshot(TOKEN)));
      t.onEvent(end);
      expect(record(s)).toBeNull();
    }
  });

  test("other traffic leaves it alone", () => {
    const s = new MemoryStorage();
    const t = trackShareToken(s, "lobby");
    t.onEvent(message(snapshot(TOKEN)));
    t.onEvent({ type: "connecting" });
    t.onEvent(message({ type: "chat", memberId: "me", text: "hi", at: 1 }));
    expect(record(s)).toEqual({ roomId: "lobby", token: TOKEN });
  });

  test("storage that throws (disabled, quota) never breaks the room", () => {
    const broken: ShareTokenStorage = {
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const t = trackShareToken(broken, "lobby");
    expect(() => {
      t.onEvent(message(snapshot(TOKEN)));
      t.onEvent({ type: "disconnected" });
      t.clear();
    }).not.toThrow();
  });
});
