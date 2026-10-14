import { describe, expect, test } from "bun:test";
import { ERROR_TEXT, STATUS_TEXT } from "../src/controls/feedback";
import { stoppedConnection } from "../src/room-socket";

// OME-1100: the room's status line and notice words, and the socket adapters, moved out of room.ts.

describe("room words", () => {
  test("only connecting and reconnecting say anything on the status line", () => {
    expect(STATUS_TEXT.connecting).toBe("Connecting…");
    expect(STATUS_TEXT.reconnecting).toBe("Connection lost, reconnecting…");
    expect(Object.entries(STATUS_TEXT).filter(([, t]) => t !== "").map(([k]) => k).sort()).toEqual(["connecting", "reconnecting"]);
  });

  test("a server error is said in plain words", () => {
    expect(ERROR_TEXT.queue_full).toBe("The queue is full. Remove one to add another.");
    expect(ERROR_TEXT.seat_taken).toBe("Someone just took that seat.");
  });
});

describe("stoppedConnection (a tab inside its rejoin cooldown)", () => {
  test("never sends", () => {
    expect(stoppedConnection().send({ type: "leave" })).toBe(false);
  });
});
