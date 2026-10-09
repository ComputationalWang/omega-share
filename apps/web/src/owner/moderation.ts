// The owner's moderation tools (ADR 0030, set j "house rules"). A lazy chunk that only an owner's page loads, like the
// layout editor: guests never download it. Another member's name tag opens a small popover (a dialog of plain buttons:
// Mute / Unmute chat, Remove from room, which asks first); the bar holds "Who controls playback", a radio group. The server checks the owner token before anything
// happens, so this is UI only. Text only: every string goes in via textContent.
import type { ClientMessage, ControlPolicy, MemberId } from "@omega/shared";
import { el, sprite } from "../controls/dom";
import type { Point } from "../layout";
import { controlPolicy, isMuted, type ViewState } from "../state";

export interface ModerationOptions {
  /** The scaled stage: the menu sits in its coordinates, over the member's name tag. */
  readonly stage: HTMLElement;
  /** The name-tag layer (room.ts): one `[data-member]` span per member. */
  readonly tags: HTMLElement;
  /** Where the playback setting goes. */
  readonly bar: HTMLElement;
  readonly view: () => ViewState;
  readonly send: (m: ClientMessage) => boolean;
  /** The top of a member's name tag on the stage now: the menu's tail points there. */
  readonly anchor: (id: MemberId) => Point | undefined;
  /** The stage's width in its own px (layout.ts STAGE_W): the menu stays inside it. */
  readonly stageWidth: number;
}

export interface Moderation {
  /** After every render: tags, the open menu and the setting follow the state. Cheap when nothing changed. */
  update(): void;
  /** A keydown on the page: Escape closes the menu. True if it was ours. */
  key(ev: KeyboardEvent): boolean;
  destroy(): void;
}

/** Portrait sprites by avatar index (assets/README.md: juno, pip, mo, kiki). */
const PORTRAITS = ["juno", "pip", "mo", "kiki"] as const;
/** The menu stays this far (stage px) from the stage's sides; its tail still points at the member. */
const MENU_HALF_W = 110;

const POLICY_TEXT: Record<ControlPolicy, string> = {
  everyone: "Anyone in the room can play, pause and skip. Everyone sees who did it.",
  owner: "Only you can play, pause and skip. Everyone else sees “Host” on the remote.",
};

export function mountModeration(o: ModerationOptions): Moderation {
  // ---- The member menu: the emote picker's tray (mustard "only you" rim), rows instead of cells.
  const menu = el("div", { className: "ui-emotes ui-modmenu mod-menu", role: "dialog" }, "mod-menu");
  const portrait = sprite("ui-portrait-juno");
  const name = el("span", { className: "name" });
  const close = el("button", { type: "button", className: "ui-button secondary icon mod-close", ariaLabel: "Close" }, "mod-close");
  close.append(sprite("ui-icon-close"));
  const head = el("div", { className: "head" });
  head.append(portrait, name, close);
  const muteIcon = sprite("ui-icon-chat-mute");
  const muteRow = el("button", { type: "button", className: "ui-modrow" }, "mod-mute");
  // A row that turns into the question with its two keys, so it's a box holding buttons rather than one button.
  const removeRow = el("div", { className: "ui-modrow mod-remove-row" }, "mod-remove");
  const removeKey = el("button", { type: "button", className: "mod-remove-key" });
  removeKey.append(sprite("ui-icon-remove"), "Remove from room");
  const keep = el("button", { type: "button", className: "ui-button secondary", textContent: "Keep" }, "mod-keep");
  const confirm = el("button", { type: "button", className: "ui-button", textContent: "Remove" }, "mod-confirm");
  menu.append(head, el("span", { className: "ui-modsep" }), muteRow, removeRow);

  /** Whose menu is open; null = closed (the menu is out of the DOM). */
  let target: MemberId | null = null;
  /** The tag it was opened from: focus goes back there on close. */
  let opener: HTMLElement | null = null;
  let placedAt = "";
  let asking = false;
  let shownMuted: boolean | null = null;

  const showRemove = (ask: boolean, nickname: string): void => {
    asking = ask;
    removeRow.classList.toggle("is-ask", ask);
    if (ask) {
      const q = el("span", { className: "ask", textContent: `Remove ${nickname} for 10 min?` });
      removeRow.replaceChildren(q, keep, confirm);
    } else {
      removeRow.replaceChildren(removeKey);
    }
  };

  const closeMenu = (): void => {
    const back = opener;
    target = null;
    opener = null;
    asking = false;
    shownMuted = null;
    placedAt = "";
    menu.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    if (back?.isConnected === true) {
      back.setAttribute("aria-expanded", "false");
      if (menu.contains(document.activeElement) || document.activeElement === document.body || document.activeElement === back) back.focus();
    }
  };

  /** A press anywhere but the menu or a name tag closes it (a tag press toggles or switches the menu itself). */
  function onOutside(ev: Event): void {
    const t = ev.target;
    if (t instanceof Node && (menu.contains(t) || (t instanceof Element && t.closest("[data-member]") !== null && o.tags.contains(t)))) return;
    closeMenu();
  }

  const openMenu = (id: MemberId, from: HTMLElement | null): void => {
    const s = o.view();
    const m = s.room?.members.find((x) => x.id === id);
    if (m === undefined || id === s.self) return;
    if (target !== null) closeMenu();
    target = id;
    opener = from;
    from?.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    shownMuted = null;
    portrait.className = `ui-sprite ui-portrait-${PORTRAITS[m.avatar] ?? "juno"}`;
    name.textContent = m.nickname;
    menu.setAttribute("aria-label", m.nickname);
    showRemove(false, m.nickname);
    placeMenu(id);
    o.stage.append(menu);
    syncMenu(s);
  };

  /** Over the member's tag, kept inside the stage; the tail keeps pointing at the member. */
  const placeMenu = (id: MemberId): void => {
    const p = o.anchor(id);
    if (p === undefined) return;
    const x = Math.min(o.stageWidth - MENU_HALF_W, Math.max(MENU_HALF_W, p.x));
    const transform = `translate(${String(x)}px, ${String(p.y - 6)}px)`;
    if (transform === placedAt) return;
    placedAt = transform;
    menu.style.transform = transform;
    menu.style.setProperty("--ui-tail-x", `calc(50% + ${String(p.x - x)}px)`);
  };

  /** The open menu follows the state: its member left → close; moved → it follows; their mute changed → the row flips. */
  const syncMenu = (s: ViewState): void => {
    if (target === null) return;
    if (s.room?.members.some((m) => m.id === target) !== true) {
      closeMenu();
      return;
    }
    placeMenu(target);
    const muted = isMuted(s, target);
    if (muted === shownMuted) return;
    shownMuted = muted;
    muteIcon.className = `ui-sprite ${muted ? "ui-icon-chat" : "ui-icon-chat-mute"}`;
    muteRow.replaceChildren(muteIcon, muted ? "Unmute chat" : "Mute chat");
  };

  muteRow.addEventListener("click", () => {
    if (target === null) return;
    o.send({ type: "mute", memberId: target, muted: !isMuted(o.view(), target) });
    closeMenu();
  });
  removeKey.addEventListener("click", () => {
    if (target === null || asking) return;
    showRemove(true, name.textContent);
    confirm.focus();
  });
  keep.addEventListener("click", () => {
    showRemove(false, name.textContent);
    removeKey.focus();
  });
  confirm.addEventListener("click", () => {
    if (target !== null) o.send({ type: "kick", memberId: target });
    closeMenu();
  });
  close.addEventListener("click", closeMenu);

  // ---- Name tags: for the owner, other members' tags are menu buttons.
  const pickedFrom = (t: EventTarget | null): MemberId | null => {
    if (!(t instanceof Element)) return null;
    const tag = t.closest<HTMLElement>("[data-member]");
    const id = tag?.dataset["member"];
    return id === undefined || id === o.view().self ? null : id;
  };
  const tagOf = (t: EventTarget | null): HTMLElement | null => (t instanceof Element ? t.closest<HTMLElement>("[data-member]") : null);
  const onTagClick = (ev: MouseEvent): void => {
    const id = pickedFrom(ev.target);
    if (id === null) return;
    if (id === target) closeMenu();
    else openMenu(id, tagOf(ev.target));
  };
  const onTagKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const id = pickedFrom(ev.target);
    if (id === null) return;
    ev.preventDefault();
    openMenu(id, tagOf(ev.target));
    muteRow.focus();
  };
  o.tags.addEventListener("click", onTagClick);
  o.tags.addEventListener("keydown", onTagKey);
  o.tags.classList.add("pickable");

  /** Zips on muted members' tags (only the host sees these: they're the one who can lift them). */
  const zips = new Map<HTMLElement, HTMLElement>();
  let taggedMembers: unknown = null;
  let taggedMuted: unknown = null;
  const syncTags = (s: ViewState): void => {
    // Tags only change with the members (room.ts adds/removes one per member) and the mutes.
    const members = s.room?.members;
    if (members === taggedMembers && s.muted === taggedMuted) return;
    taggedMembers = members;
    taggedMuted = s.muted;
    for (const tag of o.tags.querySelectorAll<HTMLElement>("[data-member]")) {
      const id = tag.dataset["member"];
      if (id === undefined) continue;
      const mine = id === s.self;
      if (!mine && tag.getAttribute("role") !== "button") {
        tag.setAttribute("role", "button");
        tag.tabIndex = 0;
        tag.setAttribute("aria-haspopup", "dialog");
        tag.setAttribute("aria-expanded", "false");
        tag.ariaLabel = `${tag.textContent}: host options`;
      }
      const want = !mine && isMuted(s, id);
      const zip = zips.get(tag);
      if (want === (zip !== undefined)) continue;
      if (zip !== undefined) {
        zip.remove();
        zips.delete(tag);
      } else {
        const z = sprite("ui-glyph-chat-mute");
        z.classList.add("tag-zip");
        tag.append(z);
        zips.set(tag, z);
      }
    }
    // Tags whose member left take their zip along.
    for (const tag of zips.keys()) if (!tag.isConnected) zips.delete(tag);
  };

  // ---- Who controls playback: two radio tiles (set c's picker frames), each a remote and the words.
  const setting = el("div", { className: "ui-panel mod-policy", role: "group" }, "control-policy");
  const heading = el("p", { className: "mod-policy-head" });
  heading.append(sprite("ui-icon-remote"), "Who controls playback");
  const group = el("div", { className: "mod-policy-tiles", role: "radiogroup", ariaLabel: "Who controls playback" });
  const pick = (policy: ControlPolicy): void => {
    const s = o.view();
    if (s.status === "open" && controlPolicy(s) !== policy) o.send({ type: "control-policy", policy });
  };
  const tile = (policy: ControlPolicy, icon: string, label: string): HTMLButtonElement => {
    const b = el("button", { type: "button", className: "ui-picker mod-policy-tile", role: "radio" }, "control-policy-option");
    b.dataset["policy"] = policy;
    b.append(sprite(icon), label);
    b.addEventListener("click", () => {
      pick(policy);
    });
    return b;
  };
  const tiles = [tile("everyone", "ui-icon-remote", "Everyone"), tile("owner", "ui-icon-remote-host", "Only me")];
  // A radio group: one tab stop (the checked tile); arrows move to the other tile and pick it.
  group.addEventListener("keydown", (ev) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) return;
    ev.preventDefault();
    const other = tiles.find((b) => b.getAttribute("aria-checked") !== "true");
    const policy = other?.dataset["policy"];
    if (policy === "everyone" || policy === "owner") pick(policy);
  });
  const explain = el("p", { className: "mod-policy-note" });
  group.append(...tiles);
  setting.append(heading, group, explain);
  o.bar.append(setting);
  let shownPolicy: ControlPolicy | null = null;
  const syncSetting = (s: ViewState): void => {
    const p = controlPolicy(s);
    if (p === shownPolicy) return;
    shownPolicy = p;
    const focused = tiles.some((b) => b === document.activeElement);
    for (const b of tiles) {
      const on = b.dataset["policy"] === p;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focused) b.focus();
    }
    explain.textContent = POLICY_TEXT[p];
  };

  return {
    update() {
      const s = o.view();
      syncTags(s);
      syncMenu(s);
      syncSetting(s);
    },
    key(ev) {
      if (ev.key !== "Escape" || target === null) return false;
      closeMenu();
      return true;
    },
    destroy() {
      closeMenu();
      setting.remove();
      o.tags.removeEventListener("click", onTagClick);
      o.tags.removeEventListener("keydown", onTagKey);
      o.tags.classList.remove("pickable");
      for (const z of zips.values()) z.remove();
      zips.clear();
      for (const tag of o.tags.querySelectorAll<HTMLElement>("[data-member]")) {
        tag.removeAttribute("aria-expanded");
        tag.removeAttribute("role");
        tag.removeAttribute("tabindex");
        tag.removeAttribute("aria-haspopup");
        tag.removeAttribute("aria-label");
      }
    },
  };
}
