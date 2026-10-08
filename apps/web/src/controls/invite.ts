import { el } from "./dom";

// Plain "copy invite link" control (OME-409); design set (i) skins it later. Text only, like every string on the page.

/** A read-only box with `link` and a copy button. If the clipboard is refused, the link is selected for Ctrl+C. */
export function createInviteControl(link: string, isPrivate: boolean, writeText: (text: string) => Promise<void>): HTMLElement {
  const root = el("div", { className: "invite" }, "invite");
  const label = el("label", { textContent: "Invite link" });
  const input = el("input", { type: "text", id: "invite-link", readOnly: true, value: link }, "invite-link");
  label.htmlFor = input.id;
  const copy = el("button", { type: "button", className: "invite-copy", textContent: "Copy" }, "invite-copy");
  copy.addEventListener("click", () => {
    writeText(link).then(
      () => {
        copy.textContent = "Copied";
      },
      () => {
        input.focus();
        input.select();
        copy.textContent = "Press Ctrl+C to copy";
      },
    );
  });
  root.append(label, input, copy);
  if (isPrivate) root.append(el("p", { className: "invite-note", textContent: "Anyone with this link can join." }));
  return root;
}
