// Outfit slots (OME-1453): "Save outfit / Wear" × 3 in the People panel, under the look rows. Client-only: Wear hands
// the outfit to the room, which picks it in the existing rows (so only what changed is sent, and saved for next time).
import { el } from "../controls/dom";
import { AVATAR_IDS } from "../walk/tint";
import { OUTFIT_SLOTS, readOutfits, saveOutfit, type Outfit } from "./outfits";
import type { KeyValueStore } from "../profile";

export interface OutfitSlotsOptions {
  readonly store: KeyValueStore;
  /** What I wear now; null before I've joined. */
  readonly current: () => Outfit | null;
  /** Put on its tint, hair and accessory. */
  readonly wear: (o: Outfit) => void;
}

const avatarName = (a: number): string => {
  const id = AVATAR_IDS[a] ?? "";
  return id.charAt(0).toUpperCase() + id.slice(1);
};

export function createOutfitSlots(o: OutfitSlotsOptions): HTMLElement {
  const root = el("div", { className: "outfits" }, "outfits");
  const list = el("ul", { className: "people-list" });
  root.append(el("p", { className: "people-note", textContent: "Outfits, saved in this browser." }), list);
  for (let i = 0; i < OUTFIT_SLOTS; i++) {
    const n = String(i + 1);
    const label = el("span", { className: "people-name" });
    const note = el("span", { className: "people-note" });
    const save = el("button", { type: "button", className: "ui-button secondary", textContent: "Save outfit" });
    save.setAttribute("aria-label", `Save outfit ${n}`);
    const wear = el("button", { type: "button", className: "ui-button secondary", textContent: "Wear" });
    wear.setAttribute("aria-label", `Wear outfit ${n}`);
    const paint = (fit: Outfit | null): void => {
      label.textContent = fit === null ? `Outfit ${n}: empty` : `Outfit ${n}: ${avatarName(fit.avatar)}`;
      wear.disabled = fit === null;
    };
    paint(readOutfits(o.store)[i] ?? null);
    save.addEventListener("click", () => {
      const now = o.current();
      if (now === null || !saveOutfit(o.store, i, now)) return;
      note.textContent = "";
      paint(now);
    });
    wear.addEventListener("click", () => {
      // Read again: another tab may have saved over it.
      const fit = readOutfits(o.store)[i] ?? null;
      paint(fit);
      const now = o.current();
      if (fit === null || now === null) return;
      // There is no in-room avatar change (the avatar goes with `join`): wear the rest and say so.
      note.textContent = fit.avatar === now.avatar ? "" : `Avatar is picked when you join (${avatarName(fit.avatar)}).`;
      o.wear(fit);
    });
    const li = el("li", { className: "people-row" }, "outfit-slot");
    li.append(label, save, wear, note);
    list.append(li);
  }
  return root;
}
