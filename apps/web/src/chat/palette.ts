// The command palette (OME-1586): a "✦" key beside the emote key opens a modal <dialog> built from the command table,
// so what it offers is what the parser runs and /help names. A run entry goes out through the composer form (the very
// path a typed command takes, here or in the pop-out); a fill entry puts the command in the field for you to finish.
// DOM only, built on the first open. Focus is trapped inside, arrows move between entries, Esc closes, and no key
// leaks to the page (the room's 1–9 and T wait).
import { el, sprite } from "../controls/dom";
import { emoteIcon } from "../emote/emotes";
import { COMMANDS, type Command } from "./commands";

export interface CommandPalette {
  /** The key and its dialog; goes beside the emote picker. */
  readonly root: HTMLElement;
  readonly key: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  isOpen(): boolean;
}

const SECTIONS: readonly (readonly [Command["section"], string])[] = [
  ["emotes", "Emotes"],
  ["fun", "Fun"],
  ["moves", "Moves"],
];

let instances = 0;

export function createCommandPalette(o: { readonly input: HTMLInputElement; readonly form: HTMLFormElement }): CommandPalette {
  const n = String(++instances);
  const key = el("button", { type: "button", className: "ui-button self icon palette-key", title: "More commands", textContent: "✦" }, "palette-key");
  key.setAttribute("aria-label", "More commands");
  key.setAttribute("aria-haspopup", "dialog");
  const dialog = el("dialog", { className: "ui-panel help-dialog palette" }, "palette");
  dialog.setAttribute("aria-modal", "true");
  const root = el("span", { className: "palette-root" });
  root.append(key, dialog);
  const items: HTMLButtonElement[] = [];

  const close = (focus: HTMLElement): void => {
    if (dialog.open) dialog.close();
    focus.focus();
  };

  const act = (text: string, does: "run" | "fill"): void => {
    if (does === "run") {
      // shortcut: the pop-out clears its field when the room acks the line, so a draft there is lost; keep it in a field-free slot if that bites.
      const draft = o.input.value;
      o.input.value = text;
      o.form.requestSubmit();
      o.input.value = draft;
      close(key);
      return;
    }
    close(o.input);
    o.input.value = text;
    // The placeholder after the command is selected, so typing replaces it; `/hug @` leaves the caret on the @.
    o.input.setSelectionRange(text.endsWith("@") ? text.length : text.indexOf(" ") + 1, text.length);
    o.input.dispatchEvent(new Event("input"));
  };

  const build = (): void => {
    const title = el("h2", { id: `palette-title-${n}`, textContent: "Commands" });
    dialog.setAttribute("aria-labelledby", title.id);
    dialog.append(title);
    for (const [section, heading] of SECTIONS) {
      const part = el("section", { className: "help-part" });
      const list = el("ul", { className: "palette-list" });
      for (const c of COMMANDS) {
        if (c.section !== section) continue;
        const hint = el("span", { className: "palette-hint", textContent: c.hint });
        if (c.section === "moves") {
          const li = el("li", { className: "palette-move" });
          li.append(el("b", { textContent: c.label }), " ", hint);
          list.append(li);
          continue;
        }
        const b = el("button", { type: "button", className: "palette-item" }, "palette-item");
        b.dataset["command"] = c.text;
        if (c.emote !== undefined) b.append(sprite(emoteIcon(c.emote)));
        b.append(el("b", { textContent: c.label }), hint);
        const { text, does } = c;
        b.addEventListener("click", () => {
          act(text, does);
        });
        const li = el("li");
        li.append(b);
        list.append(li);
        items.push(b);
      }
      part.append(el("h3", { textContent: heading }), list);
      dialog.append(part);
    }
    const done = el("button", { type: "button", className: "ui-button", textContent: "Close" }, "palette-close");
    done.addEventListener("click", () => {
      close(key);
    });
    const acts = el("div", { className: "acts" });
    acts.append(done);
    dialog.append(acts);
  };

  key.addEventListener("click", () => {
    if (items.length === 0) build();
    dialog.showModal();
    items[0]?.focus();
  });
  // Esc: our own close, so focus goes back to the key.
  dialog.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    close(key);
  });
  dialog.addEventListener("keydown", (ev) => {
    // The page's keys (1–9, T, ?) sleep while the palette is up; Esc still cancels (the dialog's default action).
    ev.stopPropagation();
    // Arrows rove over the entries; Tab wraps over every key, Close included (the focus trap).
    const stops = ev.key === "Tab" ? [...dialog.querySelectorAll<HTMLButtonElement>("button")] : items;
    const at = stops.findIndex((b) => b === document.activeElement);
    const last = stops.length - 1;
    const to =
      ev.key === "ArrowDown" ? (at + 1) % stops.length
      : ev.key === "ArrowUp" ? (at <= 0 ? last : at - 1)
      : ev.key === "Home" ? 0
      : ev.key === "End" ? last
      : ev.key === "Tab" && !ev.shiftKey && at === last ? 0
      : ev.key === "Tab" && ev.shiftKey && at <= 0 ? last
      : null;
    if (to === null) return;
    ev.preventDefault();
    stops[to]?.focus();
  });
  return { root, key, dialog, isOpen: () => dialog.open };
}
