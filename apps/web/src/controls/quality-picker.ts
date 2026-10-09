// The per-viewer quality key and menu (OME-599, set k `ui-m7-quality`, research R-M7b). Only you: it changes your own
// player and this device's memory, nothing goes to the room. Text only: every label goes in via textContent.
import { QUALITY_ECHO_MS } from "../player/quality";
import { el, sprite } from "./dom";
import type { PlaybackController, PlaybackView } from "./playback";

/** How long the key shows a pick landing: Twitch's quality echo window, the time its own pause/play/seek can take. */
export const QUALITY_SWITCH_MS = QUALITY_ECHO_MS;

export interface QualityPickerTimers<Timer> {
  readonly setTimeout: (fn: () => void, ms: number) => Timer;
  readonly clearTimeout: (t: Timer) => void;
}

export interface QualityPicker {
  /** The shelf key (before full screen). Hidden when the player can't be set. */
  readonly key: HTMLButtonElement;
  /** The tray; the room places it (under the shelf, or in the shelf's place in full screen). */
  readonly menu: HTMLElement;
  update(v: PlaybackView): void;
  /** Full screen: the menu is a row in place of the shelf's contents (nothing grows over the picture). */
  setRow(row: boolean): void;
  isOpen(): boolean;
  /** Close without moving focus (the room is changing layout). */
  close(): void;
  /** Open or closed: the room re-lays the shelf. */
  onToggle(fn: (open: boolean) => void): void;
}

export function createQualityPicker<Timer>(c: Pick<PlaybackController, "setQuality">, t: QualityPickerTimers<Timer>): QualityPicker {
  const key = el("button", { type: "button", className: "ui-button self icon quality-key", hidden: true }, "quality-key");
  key.setAttribute("aria-haspopup", "menu");
  key.setAttribute("aria-expanded", "false");
  key.append(sprite("ui-icon-quality"));
  const wait = sprite("ui-wait");
  const menu = el("div", { className: "ui-emotes ui-modmenu ui-qmenu quality-menu is-below", role: "menu", ariaLabel: "Quality, only you", hidden: true }, "quality-menu");
  const head = el("div", { className: "head" });
  const selfChip = el("span", { className: "ui-chip self", textContent: "Only you" });
  head.append(sprite("ui-icon-quality"), el("span", { className: "name", textContent: "Quality" }), selfChip);
  const rowsBox = el("div", { className: "quality-rows" });
  const foot = el("p", { className: "foot", textContent: "Only on this device." });
  const closeKey = el("button", { type: "button", className: "ui-sprite ui-qx", ariaLabel: "Close quality" }, "quality-close");
  menu.append(head, el("span", { className: "ui-modsep" }), rowsBox, foot);

  let view: PlaybackView | null = null;
  let open = false;
  let row = false;
  /** The id just picked: checked, with the key switching, for the echo window (adapters report a pick at once, so it can't wait for them). */
  let pending: string | null = null;
  let switchTimer: Timer | null = null;
  let shownList: PlaybackView["qualities"] | null = null;
  const rows: HTMLButtonElement[] = [];
  /** Each row's option id, by row. */
  const ids = new Map<Element, string>();
  let toggled: (open: boolean) => void = () => undefined;

  const options = (): PlaybackView["qualities"] => view?.qualities ?? [];
  const labelOf = (id: string | null): string | null => options().find((o) => o.id === id)?.label ?? null;
  const checked = (): string | null => pending ?? view?.quality ?? null;

  const renderKey = (): void => {
    const switching = pending !== null && switchTimer !== null;
    key.classList.toggle("is-switching", switching);
    if (switching) {
      key.setAttribute("aria-busy", "true");
      if (wait.parentElement !== key) key.append(wait);
      key.ariaLabel = `Quality: switching to ${labelOf(pending) ?? ""}. Only you.`;
      return;
    }
    key.removeAttribute("aria-busy");
    wait.remove();
    const now = labelOf(view?.quality ?? null);
    key.ariaLabel = now === null ? "Quality. Only you." : `Quality: ${now}. Only you.`;
  };

  const renderRows = (): void => {
    const list = options();
    if (list !== shownList) {
      shownList = list;
      rows.length = 0;
      ids.clear();
      for (const o of list) {
        const r = el("button", { type: "button", className: "ui-modrow", role: "menuitemradio" }, "quality-option");
        ids.set(r, o.id);
        r.append(sprite("ui-glyph-check"), o.label);
        rows.push(r);
      }
      rowsBox.replaceChildren(...rows);
    }
    const on = checked();
    for (const r of rows) r.setAttribute("aria-checked", String(ids.get(r) === on));
  };

  const setOpen = (next: boolean, focusKey: boolean): void => {
    if (open === next) return;
    open = next;
    menu.hidden = !open;
    key.setAttribute("aria-expanded", String(open));
    key.classList.toggle("is-press", open);
    if (open) {
      menu.classList.toggle("is-row", row);
      menu.classList.toggle("is-below", !row);
      if (row) menu.append(closeKey);
      else closeKey.remove();
      renderRows();
      // The room places it first: focus only lands on a connected row.
      toggled(true);
      const on = rows.find((r) => ids.get(r) === checked()) ?? rows[0];
      on?.focus({ preventScroll: true });
      return;
    }
    toggled(false);
    if (focusKey) key.focus({ preventScroll: true });
  };

  const pick = (id: string): void => {
    if (id === checked()) return;
    pending = id;
    if (switchTimer !== null) t.clearTimeout(switchTimer);
    switchTimer = t.setTimeout(() => {
      switchTimer = null;
      pending = null;
      renderKey();
      if (open) renderRows();
    }, QUALITY_SWITCH_MS);
    c.setQuality(id);
    renderKey();
    renderRows();
  };

  const move = (from: EventTarget | null, by: number): void => {
    const i = rows.findIndex((r) => r === from);
    const n = rows.length;
    if (n === 0) return;
    rows[(((i < 0 ? 0 : i + by) % n) + n) % n]?.focus({ preventScroll: true });
  };

  key.addEventListener("click", () => {
    setOpen(!open, false);
  });
  key.addEventListener("keydown", (e) => {
    // Enter and Space open it as a click; ↓ too. Focus lands on the current choice.
    if (e.key !== "ArrowDown" || open) return;
    e.preventDefault();
    setOpen(true, false);
  });
  menu.addEventListener("click", (e) => {
    const r = e.target instanceof Element ? e.target.closest<HTMLElement>("[role=menuitemradio]") : null;
    const id = r === null ? undefined : ids.get(r);
    if (id !== undefined) pick(id);
  });
  closeKey.addEventListener("click", () => {
    setOpen(false, true);
  });
  menu.addEventListener("keydown", (e) => {
    const back = row ? "ArrowLeft" : "ArrowUp";
    const fwd = row ? "ArrowRight" : "ArrowDown";
    if (e.key === "Escape") setOpen(false, true);
    else if (e.key === fwd) move(e.target, 1);
    else if (e.key === back) move(e.target, -1);
    else if (e.key === "Home") rows[0]?.focus({ preventScroll: true });
    else if (e.key === "End") rows.at(-1)?.focus({ preventScroll: true });
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  menu.addEventListener("focusout", (e) => {
    const to = e.relatedTarget;
    if (to instanceof Node && (menu.contains(to) || to === key)) return;
    setOpen(false, false);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    const at = e.target;
    if (at instanceof Node && (menu.contains(at) || key.contains(at))) return;
    setOpen(false, false);
  });

  return {
    key,
    menu,
    update(v) {
      const prev = view;
      view = v;
      if (prev !== null && prev.qualities === v.qualities && prev.quality === v.quality) return;
      const none = v.qualities.length === 0;
      if (none) {
        pending = null;
        setOpen(false, false);
      }
      key.hidden = none;
      renderKey();
      if (open) renderRows();
    },
    setRow(r) {
      if (row === r) return;
      row = r;
      setOpen(false, false);
    },
    isOpen: () => open,
    close() {
      setOpen(false, false);
    },
    onToggle(fn) {
      toggled = fn;
    },
  };
}
