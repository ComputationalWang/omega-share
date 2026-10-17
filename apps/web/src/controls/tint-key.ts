// The room bar's Shirt key (OME-1352, ADR 0053): opens a panel under the bar with the tint row; a pick sends `set-tint`
// and everyone redraws you from `tint-changed`. The key's dot shows the tint you picked. Esc closes, focus back on the key.
import type { ClientMessage, Tint } from "@omega/shared";
import { el } from "./dom";
import { bindTintRow, buildTintRow } from "./tint-row";

export interface TintKeyOptions {
  /** My avatar's ramps (tints.json), and the tint I joined with. */
  readonly tints: readonly { readonly id: string; readonly colors: readonly string[] }[];
  readonly tint: Tint;
  readonly send: (m: ClientMessage) => boolean;
  /** A pick went out: remember it for the next visit. */
  readonly onPick: (t: Tint) => void;
}

export interface TintKey {
  readonly key: HTMLButtonElement;
  readonly panel: HTMLElement;
  /** Close the panel (the room is gone), focus back on the key if it was inside. */
  close(): void;
}

let panels = 0;

export function createTintKey(o: TintKeyOptions): TintKey {
  const key = el("button", { type: "button", className: "ui-button secondary icon tint-key", title: "Shirt colour" }, "tint-key");
  key.setAttribute("aria-expanded", "false");
  const dot = el("span", { className: "tint-dot", ariaHidden: "true" });
  key.append(dot);
  const panel = el("section", { className: "ui-panel tint-panel", hidden: true }, "tint-menu");
  panel.id = `tint-${String(++panels)}`;
  panel.setAttribute("aria-label", "Shirt colour");
  key.setAttribute("aria-controls", panel.id);
  const group = buildTintRow();
  panel.append(group);

  const paintKey = (t: Tint): void => {
    const ramp = o.tints[t];
    dot.style.setProperty("--swatch", ramp?.colors[1] ?? "");
    key.setAttribute("aria-label", `Shirt colour: ${group.querySelectorAll("[role=radio]")[t]?.getAttribute("aria-label") ?? ""}`);
  };
  const row = bindTintRow(group, (t) => {
    if (!o.send({ type: "set-tint", tint: t })) return;
    paintKey(t);
    o.onPick(t);
  });
  row.show(o.tints, o.tint);
  paintKey(o.tint);

  const close = (): void => {
    if (panel.hidden) return;
    if (panel.contains(document.activeElement)) key.focus();
    panel.hidden = true;
    key.setAttribute("aria-expanded", "false");
  };
  key.addEventListener("click", () => {
    if (!panel.hidden) {
      close();
      return;
    }
    panel.hidden = false;
    key.setAttribute("aria-expanded", "true");
    group.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  });
  panel.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    close();
  });
  return { key, panel, close };
}
