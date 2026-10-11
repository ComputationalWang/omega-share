import { el } from "./controls/dom";

export interface PortraitDockOptions {
  readonly root: HTMLElement;
  readonly log: HTMLElement;
  readonly composer: HTMLFormElement;
  readonly queue: HTMLElement;
  readonly settings: readonly HTMLElement[];
  readonly onViewport?: () => void;
}

/** Reuses the room's DOM: no second log, queue state, renderer or connection. */
export function createPortraitDock(o: PortraitDockOptions) {
  const keys = el("nav", { className: "portrait-keys", ariaLabel: "Room panels", hidden: true });
  const key = (label: string, id: string): HTMLButtonElement => el("button", { type: "button", className: "ui-button self", textContent: label }, id);
  const chat = key("Chat", "portrait-chat");
  const upNext = key("Up next", "portrait-queue");
  const settings = key("Room", "portrait-settings");
  const link = key("Link", "portrait-link");
  link.ariaLabel = "Share a video link";
  keys.append(chat, upNext, settings);
  const sheet = el("dialog", { className: "ui-panel portrait-sheet", ariaLabel: "Room panel" }, "portrait-sheet");
  const title = el("h2");
  const closeKey = key("Close", "portrait-sheet-close");
  const head = el("div", { className: "portrait-sheet-head" });
  head.append(title, closeKey);
  const content = el("div", { className: "portrait-sheet-content" });
  sheet.append(head, content);
  o.root.append(keys, sheet);
  let active = false;
  let opener: HTMLElement | null = null;
  let held: { node: HTMLElement; marker: Comment }[] = [];
  const restore = (): void => {
    for (const { node, marker } of held) marker.replaceWith(node);
    held = [];
    sheet.removeAttribute("data-panel");
    opener?.focus({ preventScroll: true });
    opener = null;
  };
  const close = (): void => {
    if (sheet.open) sheet.close();
    // Native close is asynchronous; restore immediately too, before layout changes move the nodes.
    restore();
  };
  sheet.addEventListener("close", restore);
  sheet.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
  closeKey.addEventListener("click", close);
  const open = (kind: "chat" | "queue" | "settings", from: HTMLElement, focusInput = false): void => {
    if (!active) return;
    close();
    opener = from;
    title.textContent = kind === "chat" ? "Chat" : kind === "queue" ? "Share a video link" : "Room settings";
    sheet.ariaLabel = title.textContent;
    sheet.dataset["panel"] = kind;
    const nodes = kind === "chat" ? [o.log, o.composer] : kind === "queue" ? [o.queue] : o.settings;
    held = nodes.map((node) => {
      const marker = document.createComment("portrait panel home");
      node.before(marker);
      content.append(node);
      return { node, marker };
    });
    sheet.showModal();
    const target = focusInput ? content.querySelector<HTMLInputElement>("input:not(:disabled)") : kind === "chat" ? o.log : closeKey;
    target?.focus({ preventScroll: true });
    if (kind === "chat") o.log.scrollTop = o.log.scrollHeight;
  };
  link.addEventListener("click", () => open("queue", link, true));
  upNext.addEventListener("click", () => open("queue", upNext));
  chat.addEventListener("click", () => open("chat", chat));
  settings.addEventListener("click", () => open("settings", settings));
  const viewport = (): void => {
    if (!active) return;
    const v = window.visualViewport;
    o.root.style.setProperty("--portrait-height", `${String(v?.height ?? window.innerHeight)}px`);
    o.root.style.setProperty("--portrait-top", `${String(v?.offsetTop ?? 0)}px`);
    o.root.classList.toggle("portrait-typing", v !== null && window.innerHeight - (v?.height ?? window.innerHeight) > 100);
  };
  const resized = (): void => { viewport(); o.onViewport?.(); };
  window.visualViewport?.addEventListener("resize", resized);
  window.visualViewport?.addEventListener("scroll", resized);
  window.addEventListener("resize", resized);
  return {
    keys, link, sheet, close,
    setActive(on: boolean): void {
      if (on === active) { if (on) viewport(); return; }
      close();
      active = on;
      keys.hidden = !on;
      o.root.classList.toggle("room-portrait", on);
      o.queue.classList.toggle("portrait-stowed", on);
      for (const node of o.settings) node.classList.toggle("portrait-stowed", on);
      if (on) { o.composer.insertBefore(link, o.composer.querySelector("input")); viewport(); }
      else {
        link.remove();
        o.root.classList.remove("portrait-typing");
        o.root.style.removeProperty("--portrait-height");
        o.root.style.removeProperty("--portrait-top");
      }
    },
  };
}
