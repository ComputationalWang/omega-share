import { expect, test } from "bun:test";
import * as v from "valibot";
import { RESUME_GRACE_MS, RESUME_STORAGE_KEY_PREFIX, RESUME_TOKEN_LENGTH, ResumeRecordSchema, ResumeTokenSchema } from "../src";

const token = "Ab_-" + "x".repeat(39);
const record = { roomId: "lobby", token, nickname: "Alice", avatar: 0 };

test("a room resume record round-trips, rejecting malformed credentials and extra storage fields", () => {
  expect(v.parse(ResumeRecordSchema, JSON.parse(JSON.stringify(record)))).toEqual(record);
  for (const bad of ["x".repeat(42), "x".repeat(44), "x".repeat(42) + "=", "x".repeat(42) + "/", "x".repeat(42) + "+", token + "\n", null, 43]) {
    expect(v.safeParse(ResumeTokenSchema, bad).success).toBe(false);
  }
  for (const bad of [{ ...record, secret: token }, { ...record, roomId: "../room" }, { ...record, nickname: "" }, { ...record, avatar: 4 }, { ...record, token: "x".repeat(22) }]) {
    expect(v.safeParse(ResumeRecordSchema, bad).success).toBe(false);
  }
  expect(RESUME_TOKEN_LENGTH).toBe(43);
  expect(RESUME_GRACE_MS).toBe(120_000);
  expect(RESUME_STORAGE_KEY_PREFIX).toBe("omega.resume.");
});
