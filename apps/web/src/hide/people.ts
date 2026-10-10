// The people list and "Hide for me" (OME-769, M9 W3). A "People" key in the room bar opens a list of who's in the room.
// On anyone but me there is a real button, "Hide for me" / "Show", whose accessible name says who. A hidden person keeps
// their row with a "hidden" badge (their avatar stays on the stage, dimmed). Each change is said once in a status line.
// Client-only: nothing here can send; the room hears about a change (onChange) and the stage and the logs follow.
// Rows are made once per member and patched in place, so a toggled button keeps focus. Text only.
import type { Member, MemberId } from "@omega/shared";
import { el, sprite } from "../controls/dom";
import type { HiddenMembers } from "./hidden";

export interface PeopleOptions {
  readonly hidden: HiddenMembers;
  /** `id` was hidden (true) or shown again (false) by me. */
  readonly onChange: (id: MemberId, hidden: boolean) => void;
}

export interface People {
  /** The room bar's key. */
  readonly key: HTMLButtonElement;
  /** The list, in the flow under the room bar (it never covers the picture). */
  readonly panel: HTMLElement;
  /** Says each hide and show once (role=status). */
  readonly status: HTMLElement;
  /** Members in room order and who I am. Cheap when they're the same objects as last time. */
  update(members: readonly Member[], self: MemberId | null): void;
  /** Open the list; with an id, on that member's button (a right-click or long-press on their name tag). */
  open(focus?: MemberId): void;
  close(): void;
  isOpen(): boolean;
}

interface Row {
  readonly li: HTMLLIElement;
  readonly name: HTMLSpanElement;
  readonly badge: HTMLSpanElement;
  readonly button: HTMLButtonElement | null;
  nickname: string;
  shown: boolean | null;
}

let panels = 0;

export function createPeople(o: PeopleOptions): People {
  const key = el("button", { type: "button", className: "ui-button secondary icon people-key", title: "People" }, "people-key");
  key.setAttribute("aria-label", "People");
  key.setAttribute("aria-expanded", "false");
  key.append(sprite("ui-icon-people"));
  const panel = el("section", { className: "ui-panel people", hidden: true }, "people-panel");
  panel.id = `people-${String(++panels)}`;
  key.setAttribute("aria-controls", panel.id);
  panel.setAttribute("aria-label", "People in this room");
  const list = el("ul", { className: "people-list" });
  panel.append(el("p", { className: "people-note", textContent: "Hide for me hides someone's chat, bubbles and emotes for you only. Nobody else is told." }), list);
  const status = el("p", { className: "sr-only", role: "status" }, "people-status");

  const rows = new Map<MemberId, Row>();
  let lastMembers: readonly Member[] | null = null;
  let lastSelf: MemberId | null = null;

  const paint = (id: MemberId, row: Row): void => {
    const hidden = o.hidden.has(id);
    if (row.shown === hidden) return;
    row.shown = hidden;
    row.li.classList.toggle("is-hidden", hidden);
    if (hidden) row.name.after(row.badge);
    else row.badge.remove();
    if (row.button === null) return;
    row.button.textContent = hidden ? "Show" : "Hide for me";
    row.button.setAttribute("aria-label", hidden ? `Show ${row.nickname}` : `Hide ${row.nickname} for me`);
  };

  const makeRow = (m: Member, self: boolean): Row => {
    const li = el("li", { className: "people-row" }, "people-row");
    li.dataset["member"] = m.id;
    const name = el("span", { className: "people-name", textContent: self ? `${m.nickname} (you)` : m.nickname });
    const badge = el("span", { className: "ui-tag people-hidden", textContent: "hidden" });
    li.append(name);
    let button: HTMLButtonElement | null = null;
    if (!self) {
      const b = el("button", { type: "button", className: "ui-button secondary people-toggle" }, "people-toggle");
      b.addEventListener("click", () => {
        const hide = !o.hidden.has(m.id);
        if (!o.hidden.set(m.id, hide)) return;
        const row = rows.get(m.id);
        if (row !== undefined) paint(m.id, row);
        status.textContent = hide ? `${m.nickname} is hidden for you. Only you see this.` : `${m.nickname} is shown again.`;
        o.onChange(m.id, hide);
      });
      li.append(b);
      button = b;
    }
    return { li, name, badge, button, nickname: m.nickname, shown: null };
  };

  const close = (): void => {
    if (panel.hidden) return;
    const inside = panel.contains(document.activeElement);
    panel.hidden = true;
    key.setAttribute("aria-expanded", "false");
    if (inside) key.focus();
  };
  const open = (focus?: MemberId): void => {
    panel.hidden = false;
    key.setAttribute("aria-expanded", "true");
    if (focus !== undefined) rows.get(focus)?.button?.focus();
  };
  key.addEventListener("click", () => {
    if (panel.hidden) open();
    else close();
  });
  panel.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    close();
  });

  return {
    key,
    panel,
    status,
    update(members, self) {
      // Hides change only through this list's own buttons, which repaint their row: same members, nothing to do.
      if (members === lastMembers && self === lastSelf) return;
      lastMembers = members;
      if (self !== lastSelf) {
        // Who "you" are changed (a rejoin): every row's button and name depend on it.
        for (const r of rows.values()) r.li.remove();
        rows.clear();
        lastSelf = self;
      }
      const seen = new Set<MemberId>();
      let prev: HTMLLIElement | null = null;
      for (const m of members) {
        seen.add(m.id);
        let row = rows.get(m.id);
        if (row === undefined) {
          row = makeRow(m, m.id === self);
          rows.set(m.id, row);
        }
        paint(m.id, row);
        // Room order, moving only what's out of place.
        const want: ChildNode | null = prev === null ? list.firstChild : prev.nextSibling;
        if (want !== row.li) list.insertBefore(row.li, want);
        prev = row.li;
      }
      for (const [id, r] of rows) {
        if (seen.has(id)) continue;
        r.li.remove();
        rows.delete(id);
      }
    },
    open,
    close,
    isOpen: () => !panel.hidden,
  };
}
