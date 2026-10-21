// The command palette (OME-1586).
import { el } from "../controls/dom";

export interface CommandPalette {
  readonly root: HTMLElement;
  readonly key: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  isOpen(): boolean;
}

export function createCommandPalette(_o: { readonly input: HTMLInputElement; readonly form: HTMLFormElement }): CommandPalette {
  const key = el("button", { type: "button" });
  const dialog = el("dialog");
  const root = el("span");
  root.append(key, dialog);
  return { root, key, dialog, isOpen: () => dialog.open };
}
