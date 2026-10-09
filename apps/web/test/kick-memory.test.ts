import { describe, expect, test } from "bun:test";
import { KICK_COOLDOWN_MS } from "@omega/shared";
import { bouncedUntil, kickedUntil, rememberKick } from "../src/kick-memory";

/** A Map-backed `sessionStorage`; `broken` throws like a disabled or full storage. */
function storage(broken = false) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => {
      if (broken) throw new Error("denied");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("denied");
      m.set(k, v);
    },
    removeItem: (k: string) => {
      if (broken) throw new Error("denied");
      m.delete(k);
    },
  };
}

// OME-507: a kicked tab remembers when the rejoin cooldown ends (ADR 0030 §2), so a reload inside it shows the
// notice instead of reconnecting, and the wait it shows doesn't restart.
describe("kick memory", () => {
  test("a kick is remembered for KICK_COOLDOWN_MS in this room only", () => {
    const s = storage();
    expect(rememberKick(s, "room1", 1000)).toBe(1000 + KICK_COOLDOWN_MS);
    expect(kickedUntil(s, "room1", 2000)).toBe(1000 + KICK_COOLDOWN_MS);
    expect(kickedUntil(s, "room2", 2000)).toBeNull();
  });

  test("once the cooldown is over it's forgotten", () => {
    const s = storage();
    rememberKick(s, "room1", 0);
    expect(kickedUntil(s, "room1", KICK_COOLDOWN_MS)).toBeNull();
    expect(s.m.size).toBe(0);
  });

  test("noting a bounce (4005 before any snapshot) never starts a cooldown: only a known one is read back", () => {
    const s = storage();
    expect(bouncedUntil(s, "room1", 0)).toBeNull();
    expect(s.m.size).toBe(0);
    rememberKick(s, "room1", 0);
    expect(bouncedUntil(s, "room1", 60_000)).toBe(KICK_COOLDOWN_MS);
  });

  test("bouncing off the cooldown (a join closed with 4005 again) keeps the first end time", () => {
    const s = storage();
    rememberKick(s, "room1", 0);
    expect(rememberKick(s, "room1", 60_000)).toBe(KICK_COOLDOWN_MS);
  });

  test("garbage in storage reads as no kick, and a fresh kick replaces it", () => {
    const s = storage();
    s.m.set("omega.kicked.room1", "soon");
    expect(kickedUntil(s, "room1", 0)).toBeNull();
    expect(rememberKick(s, "room1", 5)).toBe(5 + KICK_COOLDOWN_MS);
  });

  test("a stored end further away than one cooldown is not trusted", () => {
    const s = storage();
    s.m.set("omega.kicked.room1", String(10 * KICK_COOLDOWN_MS));
    expect(kickedUntil(s, "room1", 0)).toBeNull();
  });

  test("disabled storage: still says when the cooldown ends, remembers nothing", () => {
    const s = storage(true);
    expect(rememberKick(s, "room1", 0)).toBe(KICK_COOLDOWN_MS);
    expect(kickedUntil(s, "room1", 0)).toBeNull();
  });
});
