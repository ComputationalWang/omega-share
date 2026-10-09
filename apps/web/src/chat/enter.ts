/** What a key does to the chat field (OME-642): "focus" jumps to it, "blur" hands the keys back to the room. */
export type ChatKey = "focus" | "blur" | null;

type KeyLike = Pick<KeyboardEvent, "key" | "target" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "repeat" | "defaultPrevented">;

/** A popup that's open (the member menu is a role=dialog, the emote and quality pickers are menus): Enter is its business. */
const POPUP = 'dialog, [role="dialog"], [role="alertdialog"], [role="menu"]';
const OPEN_POPUP = 'dialog[open], [role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden]), [role="menu"]:not([hidden])';

/** Things that answer Enter themselves: a focused one keeps it. */
const OWN_ENTER = 'a[href], button, input, textarea, select, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="treeitem"], [role="gridcell"]';

/**
 * Enter with nothing that takes Enter focused (the page, the chat log, the room's window) jumps to the chat `field`;
 * Escape in the field blurs it. Modifiers, IME composition (its Esc dismisses the candidates), anything inside or beside an
 * open dialog or menu and a key someone else handled are left alone, and so is a held Enter (its repeats would land in
 * the field and send the draft).
 */
export function chatKey(ev: KeyLike, field: HTMLElement): ChatKey {
  if (ev.isComposing) return null;
  if (ev.key === "Escape") return ev.target === field ? "blur" : null;
  if (ev.key !== "Enter" || ev.repeat || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return null;
  const t = ev.target;
  if (field.ownerDocument.querySelector(OPEN_POPUP) !== null) return null;
  if (!(t instanceof Element)) return "focus";
  if (t.closest(POPUP) !== null) return null;
  if ((t instanceof HTMLElement && t.isContentEditable) || t.matches(OWN_ENTER)) return null;
  return "focus";
}
