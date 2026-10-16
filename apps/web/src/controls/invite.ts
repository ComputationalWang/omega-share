import { el } from "./dom";

// Plain "copy invite link" control (OME-409); design set (i) skins it later. Text only, like every string on the page.

/** How long "Copied" stays on the button before it reads "Copy" again (OME-1241). */
const COPIED_MS = 2000;

export interface InviteTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

const browserTimers: InviteTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

/**
 * A read-only box with `link` and a copy button. If the clipboard is refused, the link is selected for Ctrl+C.
 * The outcome is also told to a status region for screen readers. `stop` clears the pending label reset.
 */
export function createInviteControl(
  link: string,
  isPrivate: boolean,
  writeText: (text: string) => Promise<void>,
  timers: InviteTimers = browserTimers,
): { root: HTMLElement; stop: () => void } {
  const root = el("div", { className: "invite" }, "invite");
  const label = el("label", { textContent: "Invite link" });
  const input = el("input", { type: "text", id: "invite-link", readOnly: true, value: link }, "invite-link");
  label.htmlFor = input.id;
  const copy = el("button", { type: "button", className: "invite-copy", textContent: "Copy" }, "invite-copy");
  const status = el("p", { className: "visually-hidden", role: "status" }, "invite-status");
  let reset: unknown = null;
  const stop = (): void => {
    if (reset !== null) timers.clearTimer(reset);
    reset = null;
  };
  copy.addEventListener("click", () => {
    writeText(link).then(
      () => {
        copy.textContent = "Copied";
        status.textContent = "Invite link copied";
        stop();
        reset = timers.setTimer(() => {
          reset = null;
          copy.textContent = "Copy";
        }, COPIED_MS);
      },
      () => {
        stop();
        input.focus();
        input.select();
        copy.textContent = "Press Ctrl+C to copy";
        status.textContent = "Press Ctrl+C to copy";
      },
    );
  });
  root.append(label, input, copy, status);
  if (isPrivate) root.append(el("p", { className: "invite-note", textContent: "Anyone with this link can join." }));
  return { root, stop };
}
