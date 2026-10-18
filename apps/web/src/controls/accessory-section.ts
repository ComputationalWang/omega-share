// "Your accessory" (OME-1391): the accessory row under the tint row atop the People panel. A pick sends `set-accessory`
// and everyone redraws you from `accessory-changed`.
import type { Accessory, ClientMessage } from "@omega/shared";
import { el } from "./dom";
import { bindAccessoryRow, buildAccessoryRow } from "./accessory-row";

export interface AccessorySectionOptions {
  /** The accessory I joined with. */
  readonly accessory: Accessory;
  readonly send: (m: ClientMessage) => boolean;
  /** A pick went out: remember it for the next visit. */
  readonly onPick: (a: Accessory) => void;
}

export function createAccessorySection(o: AccessorySectionOptions): HTMLElement {
  const root = el("div", { className: "tint-section" }, "accessory-menu");
  const group = buildAccessoryRow();
  group.setAttribute("aria-label", "Your accessory");
  bindAccessoryRow(group, (a) => {
    if (o.send({ type: "set-accessory", accessory: a })) o.onPick(a);
  }).check(o.accessory);
  root.append(el("p", { className: "people-note", textContent: "Your accessory, seen by everyone." }), group);
  return root;
}
