import { describe, expect, test } from "bun:test";
import { roomIdFromPath, wsUrl } from "../src/route";

describe("roomIdFromPath", () => {
  test("reads /r/<room>", () => {
    expect(roomIdFromPath("/r/lobby")).toBe("lobby");
    expect(roomIdFromPath("/r/e2e-smoke/")).toBe("e2e-smoke");
  });
  test("the root and unknown paths use the default room", () => {
    expect(roomIdFromPath("/")).toBe("lobby");
    expect(roomIdFromPath("/about")).toBe("lobby");
  });
  test("invalid room ids fall back to the default room", () => {
    expect(roomIdFromPath("/r/UPPER")).toBe("lobby");
    expect(roomIdFromPath("/r/" + "a".repeat(33))).toBe("lobby");
    expect(roomIdFromPath("/r/..%2F")).toBe("lobby");
  });
});

describe("wsUrl", () => {
  test("maps http(s) server URLs to the room socket URL", () => {
    expect(wsUrl("http://localhost:8787", "lobby")).toBe("ws://localhost:8787/rooms/lobby/ws");
    expect(wsUrl("https://omega.example/", "lobby")).toBe("wss://omega.example/rooms/lobby/ws");
    expect(wsUrl("https://omega.example/api/", "x-1")).toBe("wss://omega.example/api/rooms/x-1/ws");
  });
  test("rejects non-http server URLs", () => {
    expect(() => wsUrl("javascript:alert(1)", "lobby")).toThrow();
  });
});
