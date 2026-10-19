// "Your shirt colour" (OME-1352, ADR 0053): the tint row at the top of the People panel. A pick sends `set-tint` and
// everyone redraws you from `tint-changed`. In the panel, not a key of its own: the room bar has no width to spare at
// 320 px (a wrapped title there costs the portrait stage its place).
import type { ClientMessage, Hair, Tint } from "@omega/shared";
import { el } from "./dom";
import { bindTintRow, buildHairRow, buildTintRow } from "./tint-row";

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

export interface HairSectionOptions {
  /** My avatar's hair ramps (hairs.json), and the hair I joined with. */
  readonly hairs: readonly { readonly id: string; readonly colors: readonly string[] }[];
  readonly hair: Hair;
  readonly send: (m: ClientMessage) => boolean;
  /** A pick went out: remember it for the next visit. */
  readonly onPick: (h: Hair) => void;
}

/** "Your hair colour" (OME-1438): the hair row beside the tint row, the same way round (`set-hair`, `hair-changed`). */
export function createHairSection(o: HairSectionOptions): HTMLElement {
  const root = el("div", { className: "tint-section" }, "hair-menu");
  const group = buildHairRow();
  group.setAttribute("aria-label", "Your hair colour");
  bindTintRow(group, (h) => {
    if (o.send({ type: "set-hair", hair: h })) o.onPick(h);
  }).show(o.hairs, o.hair);
  root.append(el("p", { className: "people-note", textContent: "Your hair colour, seen by everyone." }), group);
  return root;
}
