// "Your shirt colour" (OME-1352, ADR 0053): the tint row at the top of the People panel. A pick sends `set-tint` and
// everyone redraws you from `tint-changed`. In the panel, not a key of its own: the room bar has no width to spare at
// 320 px (a wrapped title there costs the portrait stage its place).
import type { ClientMessage, Tint } from "@omega/shared";
import { el } from "./dom";
import { bindTintRow, buildTintRow } from "./tint-row";

export interface TintSectionOptions {
  /** My avatar's ramps (tints.json), and the tint I joined with. */
  readonly tints: readonly { readonly id: string; readonly colors: readonly string[] }[];
  readonly tint: Tint;
  readonly send: (m: ClientMessage) => boolean;
  /** A pick went out: remember it for the next visit. */
  readonly onPick: (t: Tint) => void;
}

export function createTintSection(o: TintSectionOptions): HTMLElement {
  const root = el("div", { className: "tint-section" }, "tint-menu");
  const group = buildTintRow();
  group.setAttribute("aria-label", "Your shirt colour");
  bindTintRow(group, (t) => {
    if (o.send({ type: "set-tint", tint: t })) o.onPick(t);
  }).show(o.tints, o.tint);
  root.append(el("p", { className: "people-note", textContent: "Your shirt colour, seen by everyone." }), group);
  return root;
}
