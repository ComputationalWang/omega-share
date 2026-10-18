// The typing indicator's sender (OME-1390): `typing {on: true}` at most once per TYPING_RESEND_MS while the chat box has
// text (inside the server's TYPING_TIMEOUT_MS, so it stays on), `{on: false}` when the box empties or loses focus.
// A sent line clears it on the server, so then nothing goes.

/** Under TYPING_TIMEOUT_MS (5 s): a member typing on keeps their dots. */
export const TYPING_RESEND_MS = 3000;

export interface TypingSender {
  /** The box's text changed. */
  input(text: string): void;
  /** The box lost focus. */
  blur(): void;
  /** A chat line went: the server cleared typing. */
  sent(): void;
}

/** `send` is false when nothing went (no socket): the next keystroke tries again. */
export function createTypingSender(o: { now: () => number; send: (on: boolean) => boolean }): TypingSender {
  let on = false;
  let lastOn = Number.NEGATIVE_INFINITY;
  const off = (): void => {
    if (on && o.send(false)) on = false;
  };
  return {
    input(text) {
      if (text === "") {
        off();
        return;
      }
      const now = o.now();
      if (on && now - lastOn < TYPING_RESEND_MS) return;
      if (o.send(true)) {
        on = true;
        lastOn = now;
      }
    },
    blur: off,
    sent() {
      on = false;
    },
  };
}
