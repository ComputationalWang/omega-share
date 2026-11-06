import { el } from "./controls/dom";

// The room's panel (Doorstep desk, OME-2306): the invite on top, then Chat / Up next / Room as one real tablist
// (role=tablist/tab/tabpanel, one tab stop, ←/→ wrap, Home/End). It holds the room's own nodes; it builds none of them.

export type PanelTab = "chat" | "queue" | "room";

const TABS: readonly { readonly kind: PanelTab; readonly label: string; readonly testId: string }[] = [
  { kind: "chat", label: "Chat", testId: "portrait-chat" },
  { kind: "queue", label: "Up next", testId: "portrait-queue" },
  { kind: "room", label: "Room", testId: "portrait-settings" },
];

export interface RoomPanel {
  readonly root: HTMLElement;
  /** Above the tabs: the invite (always visible). */
  readonly head: HTMLElement;
  readonly tabs: HTMLElement;
  readonly panels: Readonly<Record<PanelTab, HTMLElement>>;
  selected(): PanelTab;
  select(kind: PanelTab): void;
}

export function createRoomPanel(o: { readonly onSelect?: (kind: PanelTab) => void } = {}): RoomPanel {
  const root = el("section", { className: "room-panel", ariaLabel: "Room panel" }, "room-panel");
  const head = el("div", { className: "panel-head" });
  const tabs = el("div", { className: "panel-tabs", role: "tablist", ariaLabel: "Room panel" });
  const keys = TABS.map((t) => {
    const b = el("button", { type: "button", className: "ui-button secondary panel-tab", role: "tab", id: `panel-tab-${t.kind}`, textContent: t.label }, t.testId);
    b.setAttribute("aria-controls", `panel-${t.kind}`);
    return b;
  });
  const body = (kind: PanelTab): HTMLElement => {
    const p = el("div", { className: `panel-body panel-${kind}`, role: "tabpanel", id: `panel-${kind}` });
    p.setAttribute("aria-labelledby", `panel-tab-${kind}`);
    return p;
  };
  const panels: Record<PanelTab, HTMLElement> = { chat: body("chat"), queue: body("queue"), room: body("room") };
  const bodies = TABS.map((t) => panels[t.kind]);
  tabs.append(...keys);
  root.append(head, tabs, ...bodies);
  let current: PanelTab = "room";
  const render = (kind: PanelTab): void => {
    current = kind;
    root.dataset["tab"] = kind;
    TABS.forEach((t, i) => {
      const on = t.kind === kind;
      keys[i]?.setAttribute("aria-selected", String(on));
      const k = keys[i];
      if (k !== undefined) k.tabIndex = on ? 0 : -1;
      panels[t.kind].hidden = !on;
    });
  };
  const select = (kind: PanelTab): void => {
    if (kind === current) return;
    render(kind);
    o.onSelect?.(kind);
  };
  render("chat");
  keys.forEach((b, i) => {
    b.addEventListener("click", () => {
      const t = TABS[i];
      if (t !== undefined) select(t.kind);
    });
  });
  tabs.addEventListener("keydown", (ev) => {
    const i = TABS.findIndex((t) => t.kind === current);
    const n = TABS.length;
    const to = ev.key === "ArrowRight" ? (i + 1) % n : ev.key === "ArrowLeft" ? (i + n - 1) % n : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
    const t = TABS[to];
    if (t === undefined) return;
    // The arrows are the tabs' here: never a step for the avatar or a page scroll.
    ev.preventDefault();
    ev.stopPropagation();
    select(t.kind);
    keys[to]?.focus();
  });
  return { root, head, tabs, panels, selected: () => current, select };
}
