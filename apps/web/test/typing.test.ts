import { expect, test } from "bun:test";
import { createTypingSender, TYPING_RESEND_MS } from "../src/chat/typing";

// OME-1390: the chat box tells the room I'm typing: `typing {on: true}` at most once every 3 s while there is text,
// `{on: false}` when the box empties or loses focus. A sent line clears it on the server, so nothing is sent then.

function setup() {
  let now = 0;
  const sent: boolean[] = [];
  const t = createTypingSender({ now: () => now, send: (on) => sent.push(on) > 0 });
  return { t, sent, at: (ms: number) => (now = ms) };
}

test("the resend interval is 3 s, inside the server's 5 s timeout", () => {
  expect(TYPING_RESEND_MS).toBe(3000);
});

test("the first keystroke sends on; more keystrokes within 3 s send nothing; one 3 s later sends on again", () => {
  const { t, sent, at } = setup();
  t.input("h");
  t.input("he");
  at(2999);
  t.input("hel");
  expect(sent).toEqual([true]);
  at(3000);
  t.input("hell");
  expect(sent).toEqual([true, true]);
});

test("emptying the box sends off once; typing again sends on at once", () => {
  const { t, sent, at } = setup();
  t.input("h");
  at(500);
  t.input("");
  t.input("");
  expect(sent).toEqual([true, false]);
  at(600);
  t.input("x");
  expect(sent).toEqual([true, false, true]);
});

test("losing focus sends off, only when on", () => {
  const { t, sent } = setup();
  t.blur();
  expect(sent).toEqual([]);
  t.input("h");
  t.blur();
  t.blur();
  expect(sent).toEqual([true, false]);
});

test("a sent line clears it on the server: nothing is sent, and the next keystroke sends on at once", () => {
  const { t, sent, at } = setup();
  t.input("hi");
  t.sent();
  t.blur();
  expect(sent).toEqual([true]);
  at(100);
  t.input("n");
  expect(sent).toEqual([true, true]);
});

test("a send that fails (no socket) is tried again on the next keystroke", () => {
  let now = 0;
  const sent: boolean[] = [];
  let open = false;
  const t = createTypingSender({ now: () => now, send: (on) => (open ? sent.push(on) > 0 : false) });
  t.input("h");
  open = true;
  now = 10;
  t.input("he");
  expect(sent).toEqual([true]);
});
