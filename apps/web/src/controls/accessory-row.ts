// The accessory row (OME-1391): none plus the eight head accessories (OME-1388, OME-1530) in a radiogroup, named for screen
// readers, keyed like the tint row. The landing ships it as static markup under the tint row (index.html); the People
// panel builds the same markup. The glyphs are text, so neither the landing nor the panel fetches the accessories sheet.
import { ACCESSORY_COUNT } from "@omega/shared";
import { bindRadioRow, type RadioRow } from "./tint-row";

/** Accessory 0..8 on the wire. */
const NAMES = ["None", "Party hat", "Crown", "Headphones", "Beanie", "Cap", "Flower", "Bow", "Halo"] as const;
const GLYPHS = ["∅", "🎉", "👑", "🎧", "🧶", "🧢", "🌸", "🎀", "😇"] as const;

/** The row's markup (the landing's is the same, in index.html). */
export function buildAccessoryRow(): HTMLElement {
  const group = document.createElement("div");
  group.className = "tints accessories";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Accessory");
  for (let a = 0; a < ACCESSORY_COUNT; a++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "accessory";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", NAMES[a] ?? "");
    b.dataset["accessory"] = String(a);
    b.dataset["testid"] = "accessory-option";
    const glyph = document.createElement("span");
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = GLYPHS[a] ?? "";
    b.append(glyph);
    group.append(b);
  }
  return group;
}

/** Wires a row's options; `onPick` gets an accessory other than the checked one. */
export const bindAccessoryRow: (group: HTMLElement, onPick: (a: number) => void) => RadioRow = bindRadioRow;
