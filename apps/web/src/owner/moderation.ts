// The owner's moderation tools (ADR 0030, set j "house rules"). A lazy chunk that only an owner's page loads, like the
// layout editor: guests never download it. Another member's name tag opens a small popover (a dialog of plain buttons:
// Mute / Unmute chat, Remove from room, which asks first); the bar holds "Who controls playback", a radio group. The server checks the owner token before anything
// happens, so this is UI only. Text only: every string goes in via textContent.
import type { ClientMessage, ControlPolicy, MemberId } from "@omega/shared";
import { el, sprite } from "../controls/dom";
import type { Point } from "../layout";
import { controlPolicy, isMuted, type ViewState } from "../state";

export interface ModerationOptions {
  /** The scaled `.ui-room` stage. The menu is page chrome (2 px art pixel, 12 px words; OME-1254), so it mounts in the
   * stage's parent (room.ts `.stage-clip`) and is placed in page px over the member's name tag. */
  readonly stage: HTMLElement;
  /** The name-tag layer (room.ts): one `[data-member]` span per member. */
  readonly tags: HTMLElement;
  /** Where the playback setting goes. */
  readonly bar: HTMLElement;
  readonly view: () => ViewState;
  readonly send: (m: ClientMessage) => boolean;
  /** The top of a member's name tag on the stage now, in stage px: the menu's tail points there. */
  readonly anchor: (id: MemberId) => Point | undefined;
  /** The stage's width in its own px (layout.ts STAGE_W): its on-page width over this is its scale. */
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
/** The tray's bottom sits this far (page px) over the tag: the tail's tip hangs 6 below it (reference.css
 * `.ui-emotes::after` at 2 px), so it lands 3 px onto the tag. */
const TAIL_PX = 3;

const POLICY_TEXT: Record<ControlPolicy, string> = {
  everyone: "Anyone in the room can play, pause and skip. Everyone sees who did it.",
  owner: "Only you can play, pause and skip. Everyone else sees “Host” on the remote.",
};

export function mountModeration(o: ModerationOptions): Moderation {
  const layer = o.stage.parentElement ?? o.stage;
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
  /** The stage's scale and its offset in the layer, half the menu's width and the layer's: read once per open, resize or content
   * change, so following a walk reads no layout. */
  let k = 1;
  let dx = 0;
  let dy = 0;
  let half = 0;
  let room = 0;
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
    replace();
  };

  /** Another member's tag to stand in when the opener goes (a kick), else the playback setting: never <body> (K3). */
  const otherTag = (gone: MemberId | null): HTMLElement | undefined =>
    [...o.tags.querySelectorAll<HTMLElement>("[data-member][role=button]")].find((t) => t.dataset["member"] !== gone);

  /** `moveOn`: the member is on their way out, so focus goes to another tag rather than theirs. */
  const closeMenu = (moveOn = false): void => {
    const back = opener;
    const was = target;
    target = null;
    opener = null;
    asking = false;
    shownMuted = null;
    placedAt = "";
    follow.disconnect();
    resized.disconnect();
    menu.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    back?.setAttribute("aria-expanded", "false");
    // Removing the menu dropped focus to <body> if it was inside.
    if (document.activeElement !== document.body && document.activeElement !== back) return;
    const to = back?.isConnected === true && !moveOn ? back : (otherTag(was) ?? tiles.find((b) => b.tabIndex === 0));
    to?.focus();
  };

  // A dialog: Tab and Shift+Tab go round its keys (K4).
  menu.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    ev.preventDefault();
    const keys = [...menu.querySelectorAll<HTMLElement>("button")];
    const i = keys.findIndex((k) => k === document.activeElement);
    keys[(i + (ev.shiftKey ? -1 : 1) + keys.length) % keys.length]?.focus();
  });

  /** A press anywhere but the menu or a name tag closes it (a tag press toggles or switches the menu itself). */
  function onOutside(ev: Event): void {
    const t = ev.target;
    if (t instanceof Node && (menu.contains(t) || (t instanceof Element && t.closest("[data-member], [data-pad]") !== null && o.tags.contains(t)))) return;
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
    layer.append(menu);
    syncMenu(s);
    // stage.ts moves a walking member's tag every frame without a render; a refit resizes the layer (room-layout.ts).
    if (from !== null) follow.observe(from, { attributes: true, attributeFilter: ["style"] });
    resized.observe(layer);
  };

  const measure = (): void => {
    const st = o.stage.getBoundingClientRect();
    const l = layer.getBoundingClientRect();
    k = st.width / o.stageWidth;
    dx = st.left - l.left;
    dy = st.top - l.top;
    half = menu.offsetWidth / 2;
    room = layer.clientWidth;
    placedAt = "";
  };
  const replace = (): void => {
    if (target === null || !menu.isConnected) return;
    measure();
    placeMenu(target);
  };
  const follow = new MutationObserver(() => {
    if (target !== null) placeMenu(target);
  });
  // shortcut: a stage pan or zoom that keeps the layer's size isn't seen; on a phone that's a press, which closes the menu.
  const resized = new ResizeObserver(replace);

  /** Over the member's tag (stage px × the stage's scale + its offset in the layer), kept inside the layer by the menu's
   * own width; the tail keeps pointing at the member. */
  const placeMenu = (id: MemberId): void => {
    const p = o.anchor(id);
    if (p === undefined) return;
    const px = dx + p.x * k;
    const x = Math.min(room - half, Math.max(half, px));
    const transform = `translate(${String(x)}px, ${String(dy + p.y * k - TAIL_PX)}px)`;
    if (transform === placedAt) return;
    placedAt = transform;
    menu.style.transform = transform;
    menu.style.setProperty("--ui-tail-x", `calc(50% + ${String(px - x)}px)`);
  };

  /** The open menu follows the state: its member left → close; moved → it follows; their mute changed → the row flips. */
  const syncMenu = (s: ViewState): void => {
    if (target === null) return;
    if (s.room?.members.some((m) => m.id === target) !== true) {
      closeMenu();
      return;
    }
    const muted = isMuted(s, target);
    if (muted === shownMuted) {
      placeMenu(target);
      return;
    }
    shownMuted = muted;
    muteIcon.className = `ui-sprite ${muted ? "ui-icon-chat" : "ui-icon-chat-mute"}`;
    muteRow.replaceChildren(muteIcon, muted ? "Unmute chat" : "Mute chat");
    replace();
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
    closeMenu(true);
  });
  close.addEventListener("click", () => {
    closeMenu();
  });

  // ---- Name tags: for the owner, other members' tags are menu buttons.
  // A tag, or its hit pad under the tags (stage.ts, OME-1239), which stands for it.
  const hitOf = (t: EventTarget | null): HTMLElement | null => (t instanceof Element ? t.closest<HTMLElement>("[data-member], [data-pad]") : null);
  const pickedFrom = (t: EventTarget | null): MemberId | null => {
    const hit = hitOf(t);
    const id = hit?.dataset["member"] ?? hit?.dataset["pad"];
    return id === undefined || id === o.view().self ? null : id;
  };
  const tagOf = (t: EventTarget | null): HTMLElement | null => {
    const hit = hitOf(t);
    const pad = hit?.dataset["pad"];
    if (pad === undefined) return hit;
    for (const tag of o.tags.querySelectorAll<HTMLElement>("[data-member]")) if (tag.dataset["member"] === pad) return tag;
    return null;
  };
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
      // Back to the tag even when focus had wandered off the menu (K4).
      const back = opener;
      closeMenu();
      if (back?.isConnected === true) back.focus();
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
