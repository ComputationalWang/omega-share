import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { RESUME_STORAGE_KEY_PREFIX, type ResumeRecord } from "@omega/shared";
import { mountRejoinChip, type RejoinChipOptions } from "../src/rejoin-chip";
import type { ResumeStore } from "../src/session-record";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const record: ResumeRecord = { roomId: "abcdefghijklmnopqrstuvwxyz", token: "A".repeat(43), nickname: "zoe", avatar: 1 };
const T = 1_000_000;

function setup(title: string | null, until = T + 10_000) {
  const data = new Map<string, string>();
  const session: ResumeStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, val) => void data.set(k, val), removeItem: (k) => void data.delete(k) };
  const went: string[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const parent = document.createElement("div");
  const opts: RejoinChipOptions = {
    parent,
    left: { record, title, until },
    now: T,
    session,
    navigate: (p) => went.push(p),
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }) - 1,
    clearTimeout: (id) => {
      const t = timers[id];
      if (t !== undefined) t.cleared = true;
    },
  };
  const chip = mountRejoinChip(opts);
  const button = chip.querySelector("button");
  if (!(button instanceof HTMLButtonElement)) throw new Error("no Rejoin button");
  return { chip, button, parent, data, went, timers };
}

describe("rejoin chip (OME-2105)", () => {
  test("says which room you left, as text, with a Rejoin key, in a polite live region", () => {
    const { chip, button, parent } = setup("<b>Film</b> night");
    expect(chip.parentElement).toBe(parent);
    expect(chip.getAttribute("role")).toBe("status");
    expect(chip.textContent).toContain("You left <b>Film</b> night");
    expect(chip.querySelector("b")).toBeNull();
    expect(button.textContent).toBe("Rejoin");
  });

  test("an untitled room reads as the room", () => {
    expect(setup(null).chip.textContent).toContain("You left the room");
  });

  test("Rejoin puts the session back for the room page and opens it", () => {
    const { button, data, went } = setup("Film night");
    button.click();
    expect(JSON.parse(data.get(RESUME_STORAGE_KEY_PREFIX + record.roomId) ?? "null")).toEqual(record);
    expect(went).toEqual([`/r/${record.roomId}`]);
  });

  test("goes away when its time is up, and takes nothing with it into storage", () => {
    const { chip, data, timers } = setup("Film night", T + 7_000);
    expect(timers.map((t) => t.ms)).toEqual([7_000]);
    timers[0]?.fn();
    expect(chip.isConnected).toBe(false);
    expect(data.size).toBe(0);
  });

  test("stays while a keyboard or screen reader user is on it", () => {
    const { button, timers } = setup("Film night");
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(timers[0]?.cleared).toBe(true);
  });
});
