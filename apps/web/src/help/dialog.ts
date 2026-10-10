// The "?" help dialog (OME-768, M9 W2). A key in the room bar, or `?` under T's rules (never in a text field, never with
// Ctrl/Alt/Meta, never over another dialog), opens a modal <dialog>: the keyboard and touch controls, the owner's tools
// (owners only), how to report a room, and the footer pages. Its content is static DOM built on the first open; nothing
// in it touches the room's canvas. Focus is trapped inside and goes back where it was. Text only.
import { el } from "../controls/dom";

export interface HelpOptions {
  /** Checked on every open: the owner's tools show only in a room you own. */
  readonly owner: () => boolean;
}

export interface Help {
  /** The room bar's key. */
  readonly key: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  isOpen(): boolean;
  /** Close; focus goes back where it was. */
  close(): void;
  /** A keydown on the page: `?` opens the dialog. True if it was ours (the caller prevents the default). */
  shortcut(ev: KeyboardEvent): boolean;
}

/** Typing somewhere: `?` belongs to the field. */
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);
}

type Row = readonly [keys: readonly string[], what: string];

const KEYBOARD: readonly Row[] = [
  [[], "Click a seat to walk over and sit."],
  [["Enter"], "Jump to the message field; Enter again sends."],
  [["Esc"], "Leave the field, close a menu, or leave full screen."],
  [["T"], "Open the emote wheel; arrows pick, Enter sends."],
  [["1–6"], "Send an emote straight away."],
  [["F"], "Full screen: the picture with the chat beside it."],
  [["?"], "This help."],
];

const TOUCH: readonly string[] = [
  "Tap a seat to sit. On a phone, drag the room's window to look around.",
  "Tap the message field to chat; the emote key opens the wheel.",
  "The frame key under the picture goes full screen.",
];

const OWNER: readonly string[] = [
  "Edit room (on a computer): move the furniture and rename the room.",
  "Tap or click someone's name tag to mute their chat or remove them from the room.",
  "Who controls playback: everyone, or only you.",
  "The invite link lets people into a private room; share it only with people you want there.",
];

const PAGES: readonly (readonly [href: string, label: string])[] = [
  ["/privacy.html", "Privacy"],
  ["/terms.html", "Terms"],
  ["/contact.html", "Contact"],
  ["/licenses.html", "Licences"],
];

let instances = 0;

export function createHelp(o: HelpOptions): Help {
  const n = String(++instances);
  const key = el("button", { type: "button", className: "ui-button secondary icon help-key", title: "Help (?)", textContent: "?" }, "help-key");
  key.setAttribute("aria-label", "Help");
  key.setAttribute("aria-haspopup", "dialog");
  key.setAttribute("aria-keyshortcuts", "?");

  const dialog = el("dialog", { className: "ui-panel help-dialog" }, "help-dialog");
  dialog.setAttribute("aria-modal", "true");
  /** The owner's part, toggled on each open; null until the first open builds the content. */
  let ownerPart: HTMLElement | null = null;
  let reportPart: HTMLElement | null = null;
  let closeKey: HTMLButtonElement | null = null;
  /** What had focus when the dialog opened; it gets it back on close. */
  let before: HTMLElement | null = null;

  const section = (title: string, testId?: string): HTMLElement => {
    const s = el("section", { className: "help-part" }, testId);
    s.append(el("h3", { textContent: title }));
    return s;
  };
  const list = (lines: readonly string[]): HTMLUListElement => {
    const ul = el("ul");
    for (const line of lines) ul.append(el("li", { textContent: line }));
    return ul;
  };

  const build = (): void => {
    const title = el("h2", { id: `help-title-${n}`, textContent: "How the room works" });
    dialog.setAttribute("aria-labelledby", title.id);

    const keyboard = section("With a keyboard");
    const dl = el("dl", { className: "help-keys" });
    for (const [keys, what] of KEYBOARD) {
      const dt = el("dt");
      if (keys.length === 0) dt.textContent = "Mouse";
      for (const k of keys) dt.append(el("kbd", { textContent: k }));
      dl.append(dt, el("dd", { textContent: what }));
    }
    keyboard.append(dl, el("p", { textContent: "Keys never fire while you're typing in a field." }));

    const touch = section("On a touch screen");
    touch.append(list(TOUCH));

    const owner = section("Your room's tools", "help-owner");
    owner.append(list(OWNER));
    ownerPart = owner;

    const report = section("Reporting a room", "help-report");
    report.append(el("p", { textContent: "Something wrong here? Use Report room at the bottom of the room. It goes to the people who run omega-share, not to the host or anyone in the room." }));
    reportPart = report;

    const pages = section("About omega-share");
    const links = el("p", { className: "help-pages" });
    PAGES.forEach(([href, label], i) => {
      if (i > 0) links.append(" · ");
      links.append(el("a", { href, textContent: label, target: "_blank", rel: "noopener noreferrer" }));
    });
    pages.append(links);

    const close = el("button", { type: "button", className: "ui-button", textContent: "Close" }, "help-close");
    close.addEventListener("click", () => {
      closeHelp();
    });
    closeKey = close;
    const acts = el("div", { className: "acts" });
    acts.append(close);
    dialog.append(title, keyboard, touch, owner, report, pages, acts);
  };

  const openHelp = (): void => {
    if (dialog.open) return;
    const focused = document.activeElement;
    before = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    if (closeKey === null) build();
    const owns = o.owner();
    if (ownerPart !== null) ownerPart.hidden = !owns;
    // An owner never reports their own room (room.ts makes no Report key for them).
    if (reportPart !== null) reportPart.hidden = owns;
    dialog.showModal();
    closeKey?.focus();
  };

  const closeHelp = (): void => {
    if (dialog.open) dialog.close();
    const back = before?.isConnected === true ? before : key;
    before = null;
    back.focus();
  };

  key.addEventListener("click", openHelp);
  // Esc: our own close, so focus goes back where it was.
  dialog.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeHelp();
  });
  // Focus is trapped inside: Tab past the last stop wraps to the first, and back.
  dialog.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    const stops = [...dialog.querySelectorAll<HTMLElement>("a[href], button")].filter((e) => e.closest("[hidden]") === null);
    const first = stops[0];
    const last = stops.at(-1);
    if (first === undefined || last === undefined) return;
    if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    } else if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    }
  });

  return {
    key,
    dialog,
    isOpen: () => dialog.open,
    close: closeHelp,
    shortcut(ev) {
      if (ev.key !== "?" || ev.isComposing || ev.ctrlKey || ev.altKey || ev.metaKey || typing(ev.target)) return false;
      if (dialog.open || document.querySelector("dialog[open]") !== null) return false;
      if (!ev.repeat) openHelp();
      return true;
    },
  };
}
