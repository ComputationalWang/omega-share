/** What a key does to the chat field (OME-642): "focus" jumps to it, "blur" hands the keys back to the room. */
export type ChatKey = "focus" | "blur" | null;

type KeyLike = Pick<KeyboardEvent, "key" | "target" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">;

/** Things that answer Enter themselves: a focused one keeps it. */
const OWN_ENTER = 'a[href], button, input, textarea, select, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]';

/**
 * Enter with nothing that takes Enter focused (the page, the chat log, the room's window) jumps to the chat `field`;
 * Escape in the field blurs it. Modifiers, IME composition and anything inside a dialog are left alone.
 */
export function chatKey(ev: KeyLike, field: HTMLElement): ChatKey {
  if (ev.key === "Escape") return ev.target === field ? "blur" : null;
  if (ev.key !== "Enter" || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey || ev.isComposing) return null;
  const t = ev.target;
  if (!(t instanceof Element)) return "focus";
  if (t.closest("dialog") !== null) return null;
  if ((t instanceof HTMLElement && t.isContentEditable) || t.matches(OWN_ENTER)) return null;
  return "focus";
}
