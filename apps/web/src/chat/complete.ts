// @-completion in the composer (OME-1531): typing `@` offers the present members, as an ARIA 1.2 combobox (the field)
// with a listbox popup. Focus stays in the field: arrows move aria-activedescendant, Enter or Tab picks, Escape closes.
import { el } from "../controls/dom";
import { completeMention, mentionQuery, type MentionQuery } from "./mention";

/**
 * Makes `input` the combobox and returns the listbox to place beside it. `options(query)` lists the names to offer.
 * Picking writes the field and fires `input`, so whoever listens (the typing indicator) sees the change.
 */
export function attachMentionComplete(input: HTMLInputElement, options: (query: string) => readonly string[]): HTMLDivElement {
  const list = el("div", { id: "mention-list", className: "mention-list ui-panel", role: "listbox", hidden: true }, "mention-list");
  list.setAttribute("aria-label", "Mention someone");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  let q: MentionQuery | null = null;
  let names: readonly string[] = [];
  let active = 0;

  const close = (): void => {
    if (list.hidden) return;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const highlight = (i: number): void => {
    active = i;
    list.querySelectorAll("[role=option]").forEach((o, j) => {
      o.setAttribute("aria-selected", String(j === i));
    });
    input.setAttribute("aria-activedescendant", `mention-opt-${String(i)}`);
  };
  const pick = (name: string): void => {
    if (q === null) return;
    const r = completeMention(input.value, q, name);
    input.value = r.value;
    input.setSelectionRange(r.caret, r.caret);
    close();
    input.dispatchEvent(new Event("input"));
  };
  const update = (): void => {
    q = mentionQuery(input.value, input.selectionStart ?? input.value.length);
    names = q === null ? [] : options(q.query);
    if (names.length === 0) {
      close();
      return;
    }
    list.replaceChildren(...names.map((name, i) => {
      const o = el("div", { id: `mention-opt-${String(i)}`, className: "mention-option", role: "option", textContent: name }, "mention-option");
      // Keeps focus in the field, so the pick lands there.
      o.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        pick(name);
      });
      return o;
    }));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(0);
  };

  input.addEventListener("input", update);
  // Back in the field with the caret still in an @word: the list comes back.
  input.addEventListener("focus", update);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (ev) => {
    if (list.hidden || ev.isComposing) return;
    const n = names.length;
    if (ev.key === "ArrowDown") highlight((active + 1) % n);
    else if (ev.key === "ArrowUp") highlight((active + n - 1) % n);
    else if (ev.key === "Enter" || (ev.key === "Tab" && !ev.shiftKey)) {
      const name = names[active];
      if (name !== undefined) pick(name);
    }
    else if (ev.key === "Escape") close();
    else return;
    // The list's key, not the form's (Enter sends) or the room's (Escape leaves the field).
    ev.preventDefault();
    ev.stopPropagation();
  });
  return list;
}
