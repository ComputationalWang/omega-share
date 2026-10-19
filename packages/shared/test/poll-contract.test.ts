import { describe, expect, test } from "bun:test";
import {
  MAX_ROOM_MEMBERS,
  POLL_DURATION_MS,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_LENGTH,
  POLL_QUESTION_MAX_LENGTH,
  VOTE_BURST,
  VOTE_REFILL_MS,
  parseClientMessage,
  parseServerMessage,
} from "../src/index";

// Watch-party polls (OME-1452, ADR 0055).

const client = (msg: unknown) => parseClientMessage(JSON.stringify(msg));
const server = (msg: unknown) => parseServerMessage(JSON.stringify(msg));

describe("the poll constants", () => {
  test("are the issue's numbers", () => {
    expect([POLL_QUESTION_MAX_LENGTH, POLL_OPTION_MAX_LENGTH, POLL_MIN_OPTIONS, POLL_MAX_OPTIONS]).toEqual([80, 40, 2, 4]);
    expect(POLL_DURATION_MS).toBe(60_000);
    // Votes: 2/s, a burst of 2.
    expect([VOTE_BURST, 1000 / VOTE_REFILL_MS]).toEqual([2, 2]);
  });
});

describe("poll-open", () => {
  test("a 1–80 char question and 2–4 options of 1–40 chars, trimmed and NFC like chat", () => {
    for (const options of [["A", "B"], ["A", "B", "C"], ["a", "b", "c", "d"], ["x".repeat(40), "🎉"]]) {
      expect(client({ type: "poll-open", question: "Next video?", options })).toEqual({ type: "poll-open", question: "Next video?", options });
    }
    expect(client({ type: "poll-open", question: "q".repeat(80), options: ["A", "B"] })).not.toBeNull();
    expect(client({ type: "poll-open", question: "  Next? ", options: [" A ", "é"] })).toEqual({ type: "poll-open", question: "Next?", options: ["A", "é"] });
  });

  test("refuses the bounds, the chat character rules and the invisible letters", () => {
    const bad: unknown[] = [
      { question: "", options: ["A", "B"] },
      { question: "   ", options: ["A", "B"] },
      { question: "q".repeat(81), options: ["A", "B"] },
      { question: "Next?", options: ["A"] },
      { question: "Next?", options: [] },
      { question: "Next?", options: ["A", "B", "C", "D", "E"] },
      { question: "Next?", options: ["A", ""] },
      { question: "Next?", options: ["A", "x".repeat(41)] },
      { question: "Next?", options: ["A", 1] },
      { question: "Next?", options: "A|B" },
      { question: "Next?‮", options: ["A", "B"] },
      { question: "Next?", options: ["A", "B​"] },
      { question: "ㅤ", options: ["A", "B"] },
      { question: "Next?", options: ["A", "ㅤㅤ"] },
      { question: "Next?", options: ["A", "é́́́"] },
      { question: "Next?", options: ["A", "B"], extra: 1 },
      { options: ["A", "B"] },
      { question: "Next?" },
    ];
    for (const msg of bad) expect(client({ type: "poll-open", ...(msg as object) })).toBeNull();
  });
});

describe("vote and poll-close", () => {
  test("vote names a poll id and an option index 0..3", () => {
    for (const option of [0, 1, 2, 3]) expect(client({ type: "vote", pollId: "p_1-X", option })).toEqual({ type: "vote", pollId: "p_1-X", option });
    for (const option of [-1, 4, 1.5, "1", null]) expect(client({ type: "vote", pollId: "p1", option })).toBeNull();
    for (const pollId of ["", "a".repeat(33), "a b", "é", 1]) expect(client({ type: "vote", pollId, option: 0 })).toBeNull();
    expect(client({ type: "vote", pollId: "p1", option: 0, extra: true })).toBeNull();
  });

  test("poll-close names a poll id", () => {
    expect(client({ type: "poll-close", pollId: "p1" })).toEqual({ type: "poll-close", pollId: "p1" });
    expect(client({ type: "poll-close" })).toBeNull();
    expect(client({ type: "poll-close", pollId: "" })).toBeNull();
  });
});

const POLL = { pollId: "p1", by: "m1", question: "Next video?", options: ["A", "B", "C"], counts: [0, 2, 1], endsAt: 1_800_000_060_000 };

describe("poll, poll-closed and the snapshot", () => {
  test("poll carries one count per option", () => {
    expect(server({ type: "poll", ...POLL })).toEqual({ type: "poll", ...POLL });
    for (const counts of [[0, 2], [0, 2, 1, 0], [0, -1, 1], [0, 0.5, 1], [0, MAX_ROOM_MEMBERS + 1, 0]]) {
      expect(server({ type: "poll", ...POLL, counts })).toBeNull();
    }
    expect(server({ type: "poll", ...POLL, options: ["A"], counts: [0] })).toBeNull();
    expect(server({ type: "poll", ...POLL, endsAt: -1 })).toBeNull();
    expect(server({ type: "poll", ...POLL, question: "" })).toBeNull();
  });

  test("poll-closed carries the final counts", () => {
    expect(server({ type: "poll-closed", pollId: "p1", counts: [1, 0] })).toEqual({ type: "poll-closed", pollId: "p1", counts: [1, 0] });
    for (const counts of [[1], [0, 0, 0, 0, 0], [0, -1]]) expect(server({ type: "poll-closed", pollId: "p1", counts })).toBeNull();
  });

  test("the snapshot may carry the active poll", () => {
    const room = { id: "lobby", seats: Array<null>(8).fill(null), members: [], embed: null };
    const snapshot = { type: "snapshot", self: "m1", room };
    expect(server(snapshot)).not.toBeNull();
    expect(server({ ...snapshot, poll: POLL })).toMatchObject({ poll: POLL });
    expect(server({ ...snapshot, poll: { ...POLL, counts: [0] } })).toBeNull();
    expect(server({ ...snapshot, poll: null })).toBeNull();
  });
});
