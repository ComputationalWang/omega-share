// The "Up next" panel (ADR 0031, set j `.ui-queue`): the room's upcoming items, a paste-a-link field and the keys to remove
// or move one (Move up/down, Alt+Arrow on a row's key; OME-1250) or play the next now. Everything here is text: titles come from the parsed embed's ids, names from `members`, and no
// row ever loads anything (a generic item stays click-to-load on the TV, ADR 0024). The list is rebuilt only when the queue,
// the members or who may act change: room.ts calls `update` once per state change, and an unchanged input costs a few compares.
import { QUEUE_MAX, canonicalizeAnyEmbed, isSyncedEmbed, normalizeHostname, type AnyEmbed, type ClientMessage, type ErrorCode, type Member, type MemberId, type QueueItem } from "@omega/shared";
import { controlHeld, type ViewState } from "../state";
import { el, sprite } from "./dom";

export interface QueuePanelOptions {
  readonly send: (m: ClientMessage) => boolean;
  /** This site's hostnames: a link to them is refused with its own reason (the server refuses it too, ADR 0024). */
  readonly ownHosts: readonly string[];
  /** Client ms (Date.now): how long ago an add went out. */
  readonly now?: () => number;
}

export interface QueuePanel {
  readonly root: HTMLElement;
  /** Portrait sheets scroll the content above a fixed paste row; other layouts keep their reading order. */
  setPortrait(on: boolean): void;
  /**
   * After every state change. Rebuilds the rows only when the queue, the members or the permissions changed.
   * True when `s.lastError` is an add refusal shown under the field (the room skips its own notice for it).
   */
  update(s: ViewState): boolean;
  /** How many times the rows were rebuilt (the "once per change" test and e2e). */
  renders(): number;
}

/** Head sprites by avatar index (assets/README.md set j `head/*`: juno, pip, mo, kiki). */
const HEADS = ["juno", "pip", "mo", "kiki"] as const;

const NOT_A_LINK = "That isn't a link. Paste the address of a video page.";
const CANT_PLAY = "That link can't play here. Try a video page's https link.";
const OWN_SITE = "That's a link to this site. Paste a video page's link.";
/** An error this long after an add, with no answer seen, isn't taken as the add's (the server answers in milliseconds). */
const ADD_ANSWER_MS = 5000;
const NO_ITEMS: readonly QueueItem[] = [];
const NO_MEMBERS: readonly Member[] = [];

/** Each row's adder as drawn (name and head), so an unchanged one is the same string; an empty queue builds none. */
function addersKey(queue: readonly QueueItem[], members: readonly Member[]): string {
  let k = "";
  for (const it of queue) {
    const m = it.by === null ? undefined : members.find((x) => x.id === it.by);
    k += m === undefined ? "\n" : `${m.id}\t${m.nickname}\t${String(m.avatar)}\n`;
  }
  return k;
}
const FULL_TEXT = `The queue is full (${String(QUEUE_MAX)}). Remove one to add another.`;

/** The server's answers to a `queue-add`, said under the field. Anything else isn't about the add. */
const ADD_ERRORS: Partial<Record<ErrorCode, string>> = {
  unsupported_url: "That link can't be played in this room.",
  rate_limited: "Too many links at once. Try again in a few seconds.",
  queue_full: FULL_TEXT,
  control_owner_only: "Only the host can change the queue now.",
  not_joined: "Still joining, try again in a moment.",
};

/** Why a pasted link won't be queued, or null if the share parser takes it (same call as the server's, ADR 0031 §2). */
export function linkProblem(input: string, ownHosts: readonly string[]): string | null {
  if (canonicalizeAnyEmbed(input, { generic: true, ownHosts }) !== null) return null;
  let host: string;
  try {
    host = new URL(input.trim()).hostname;
  } catch {
    return NOT_A_LINK;
  }
  const own = ownHosts.map(normalizeHostname).some((h) => h !== null && (host === h || host.endsWith(`.${h}`)));
  return own ? OWN_SITE : CANT_PLAY;
}

/** A row's title from the embed's own ids: we never fetch a provider's title. */
export function itemTitle(e: AnyEmbed): string {
  switch (e.provider) {
    case "youtube":
      return `YouTube video ${e.videoId}`;
    case "vimeo":
      return `Vimeo video ${e.videoId}`;
    case "twitch":
      return e.kind === "live" ? `Twitch: ${e.channel} (live)` : `Twitch video ${e.videoId}`;
    case "generic":
      return e.url.replace(/^https:\/\//, "");
  }
}

const kindOf = (e: AnyEmbed): "video" | "live" | "generic" => (!isSyncedEmbed(e) ? "generic" : e.provider === "twitch" && e.kind === "live" ? "live" : "video");

export function createQueuePanel(o: QueuePanelOptions): QueuePanel {
  const root = el("section", { className: "ui-panel ui-queue queue-panel", ariaLabel: "Up next" }, "queue-panel");
  const head = el("div", { className: "queue-head" });
  const count = el("span", { className: "queue-count" }, "queue-count");
  const next = el("button", { type: "button", className: "ui-button shared queue-next", textContent: "Play next now", hidden: true }, "queue-next");
  head.append(sprite("ui-icon-queue"), el("h3", { textContent: "Up next" }), next, count);
  const empty = el("div", { className: "ui-qempty" }, "queue-empty");
  empty.append(sprite("ui-queue-empty"), el("span", { textContent: "Nothing up next. Paste a video link to load a reel." }));
  const list = el("ol", { className: "ui-qlist" }, "queue-list");
  const form = el("form", { className: "queue-form" }, "queue-form");
  const input = el("input", { type: "text", className: "ui-input", placeholder: "Paste a video link", autocomplete: "off", ariaLabel: "Video link to add to the queue", inputMode: "url" }, "queue-url");
  input.setAttribute("aria-invalid", "false");
  const add = el("button", { type: "submit", className: "ui-button" }, "queue-add");
  add.append(sprite("ui-icon-queue-add"), "Add");
  form.append(sprite("ui-icon-link"), input, add);
  const problem = el("p", { className: "queue-problem", role: "alert", hidden: true }, "queue-problem");
  problem.append(sprite("ui-icon-warn"), el("span"));
  const full = el("p", { className: "queue-note", hidden: true }, "queue-full");
  full.append(el("span", { className: "ui-pill-full", textContent: "Full" }), " ", FULL_TEXT);
  const heldLine = el("p", { className: "queue-note", textContent: "Only the host can change the queue.", hidden: true }, "queue-held");
  const status = el("p", { className: "visually-hidden", role: "status" }, "queue-status");
  const content = el("div", { className: "queue-content" });
  content.append(head, empty, list);
  root.append(content, form, problem, full, heldLine, status);
  let portrait = false;
  /** A list that scrolls is a named tab stop (a viewer's rows have no control to scroll it by key), and only then. */
  const fitStop = (): void => {
    const over = list.scrollHeight > list.clientHeight;
    if (over === list.hasAttribute("tabindex")) return;
    if (over) {
      list.tabIndex = 0;
      list.setAttribute("aria-label", "Up next");
    } else {
      list.removeAttribute("tabindex");
      list.removeAttribute("aria-label");
    }
  };
  new ResizeObserver(fitStop).observe(list);

  let state: ViewState | null = null;
  let drawnQueue: readonly QueueItem[] | undefined;
  let drawnAdders = "";
  let drawnKey = "";
  let renders = 0;
  let shownError: ViewState["lastError"] = null;
  const now = o.now ?? Date.now;
  /**
   * Adds the server hasn't answered yet, oldest first (it answers in order): an error now is about the oldest, and puts
   * its link back in the field. One is answered per item of mine not in `mine` that shows up, or when the room had no
   * current item and now has one (an add into an empty room starts). `mine` and `current` are snapshot at the first send.
   */
  const pending: { url: string; at: number }[] = [];
  let mine = new Set<string>();
  let current: string | undefined;
  let claimed: ViewState["lastError"] = null;
  /**
   * My last move, until the next queue change: if that change swapped the item with `past` (its neighbour on the side
   * it moved to), the key gets focus back and the new place is said. Anything else (the server dropped the move, or
   * someone else's change came first) only clears it.
   */
  let moved: { id: string; key: string; past: string; by: -1 | 1 } | null = null;

  const say = (text: string | null): void => {
    problem.hidden = text === null;
    problem.lastChild?.replaceWith(el("span", { textContent: text ?? "" }));
    input.setAttribute("aria-invalid", String(text !== null));
    if (portrait && text !== null) problem.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  input.addEventListener("input", () => {
    if (!problem.hidden) say(null);
  });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const url = input.value.trim();
    if (url === "" || add.disabled) return;
    const why = linkProblem(url, o.ownHosts);
    if (why !== null) {
      say(why);
      return;
    }
    if (!o.send({ type: "queue-add", url })) return;
    const s = state;
    if (pending.length === 0) {
      mine = new Set((s?.room?.queue ?? NO_ITEMS).filter((i) => i.by !== null && i.by === s?.self).map((i) => i.id));
      current = s?.room?.itemId;
    }
    pending.push({ url, at: now() });
    input.value = "";
    say(null);
  });
  next.addEventListener("click", () => {
    const from = state?.room?.itemId;
    if (from !== undefined) o.send({ type: "queue-advance", fromItemId: from });
  });
  const move = (id: string, by: -1 | 1, key: string): void => {
    const queue = state?.room?.queue ?? NO_ITEMS;
    const from = queue.findIndex((i) => i.id === id);
    const to = from + by;
    const past = queue[to]?.id;
    if (from < 0 || past === undefined) return;
    if (o.send({ type: "queue-move", itemId: id, toIndex: to })) moved = { id, key, past, by };
  };
  list.addEventListener("click", (ev) => {
    if (!(ev.target instanceof HTMLElement)) return;
    const key = ev.target.closest<HTMLElement>("button[data-testid]");
    const id = key?.closest<HTMLElement>("[data-item]")?.dataset["item"];
    const testId = key?.dataset["testid"];
    if (id === undefined || testId === undefined) return;
    if (testId === "queue-remove") o.send({ type: "queue-remove", itemId: id });
    else if (testId === "queue-move-up") move(id, -1, testId);
    else if (testId === "queue-move-down") move(id, 1, testId);
  });
  list.addEventListener("keydown", (ev) => {
    if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") || !(ev.target instanceof HTMLElement)) return;
    const row = ev.target.closest<HTMLElement>("[data-item]");
    const id = row?.dataset["item"];
    const testId = ev.target.dataset["testid"];
    // Only rows with move keys move: the same members and rows as the keys.
    if (id === undefined || testId === undefined || row?.querySelector("[data-testid=queue-move-up]") === null) return;
    ev.preventDefault();
    move(id, ev.key === "ArrowUp" ? -1 : 1, testId);
  });
  /** The key `testId` in the row of item `id`, if it's drawn. */
  const keyOf = (id: string, testId: string): HTMLElement | null => {
    for (const r of list.children) if (r instanceof HTMLElement && r.dataset["item"] === id) return r.querySelector<HTMLElement>(`[data-testid=${testId}]`);
    return null;
  };

  const row = (it: QueueItem, i: number, s: ViewState, canRemove: (by: MemberId | null) => boolean): HTMLElement => {
    const li = el("li", { className: i === 0 ? "ui-qrow is-next" : "ui-qrow" }, "queue-row");
    li.dataset["item"] = it.id;
    const title = itemTitle(it.embed);
    const adder = it.by === null ? undefined : s.room?.members.find((m) => m.id === it.by);
    const meta = el("span", { className: "meta" });
    if (adder !== undefined) meta.append(sprite(`ui-head-${HEADS[adder.avatar] ?? "juno"}`));
    meta.append(adder === undefined ? "someone" : adder.id === s.self ? `${adder.nickname} (you)` : adder.nickname);
    const body = el("span", { className: "body" });
    body.append(el("span", { className: "title", textContent: title, title }), meta);
    const synced = isSyncedEmbed(it.embed);
    const chip = el("span", { className: synced ? "ui-chip" : "ui-chip solo" });
    chip.append(sprite(synced ? "ui-glyph-insync" : "ui-glyph-outsync"), synced ? "Synced" : "Not synced");
    li.append(sprite(`ui-qsrc ui-qsrc-${kindOf(it.embed)}`), body, chip);
    if (canRemove(it.by)) {
      const keys = el("span", { className: "queue-keys" });
      const up = el("button", { type: "button", className: "ui-button icon queue-move", textContent: "▲" }, "queue-move-up");
      up.setAttribute("aria-label", `Move ${title} up`);
      const down = el("button", { type: "button", className: "ui-button icon queue-move", textContent: "▼" }, "queue-move-down");
      down.setAttribute("aria-label", `Move ${title} down`);
      // aria-disabled, not disabled: a key that just reached an end keeps focus.
      if (i === 0) up.setAttribute("aria-disabled", "true");
      if (i === (s.room?.queue ?? NO_ITEMS).length - 1) down.setAttribute("aria-disabled", "true");
      const x = el("button", { type: "button", className: "ui-sprite ui-qx" }, "queue-remove");
      x.setAttribute("aria-label", `Remove ${title} from the queue`);
      keys.append(up, down, x);
      li.append(keys);
    }
    return li;
  };

  return {
    root,
    renders: () => renders,
    setPortrait(on) {
      if (on === portrait) return;
      portrait = on;
      if (on) {
        content.append(problem, full, heldLine);
        content.tabIndex = 0;
        content.setAttribute("role", "region");
        content.setAttribute("aria-label", "Up next and queue messages");
      } else {
        root.append(problem, full, heldLine);
        content.removeAttribute("tabindex");
        content.removeAttribute("role");
        content.removeAttribute("aria-label");
      }
      fitStop();
    },
    update(s) {
      state = s;
      const queue = s.room?.queue ?? NO_ITEMS;
      const held = controlHeld(s);
      const key = `${String(held)}|${String(s.owner)}|${s.self ?? ""}`;
      // What the rows show of `members`: a walk or a seat change makes a new array, and must not rebuild them (OME-1542).
      const adders = addersKey(queue, s.room?.members ?? NO_MEMBERS);
      if (queue !== drawnQueue || adders !== drawnAdders || key !== drawnKey) {
        const queueChanged = queue !== drawnQueue;
        drawnQueue = queue;
        drawnAdders = adders;
        drawnKey = key;
        renders++;
        const canRemove = (by: MemberId | null): boolean => !held && (s.owner || (by !== null && by === s.self));
        // A rebuild keeps focus on the same key of the same item (it would drop to the page otherwise).
        const active = document.activeElement;
        const focused = active instanceof HTMLElement && list.contains(active) ? { id: active.closest<HTMLElement>("[data-item]")?.dataset["item"], key: active.dataset["testid"] } : null;
        list.replaceChildren(...queue.map((it, i) => row(it, i, s, canRemove)));
        fitStop();
        let refocus = focused;
        if (moved !== null && queueChanged) {
          const m = moved;
          moved = null;
          const at = queue.findIndex((i) => i.id === m.id);
          if (at >= 0 && queue[at - m.by]?.id === m.past) {
            const it = queue[at];
            if (it !== undefined) {
              status.textContent = `Moved ${itemTitle(it.embed)} to place ${String(at + 1)} of ${String(queue.length)}.`;
              // A tap may not focus the key; take focus only from the list or the page, never from another control.
              if (focused !== null || active === null || active === document.body) refocus = m;
            }
          }
        }
        if (refocus?.id !== undefined && refocus.key !== undefined) keyOf(refocus.id, refocus.key)?.focus();
        count.textContent = `${String(queue.length)} / ${String(QUEUE_MAX)}`;
        empty.hidden = queue.length > 0;
        const isFull = queue.length >= QUEUE_MAX;
        full.hidden = !isFull || held;
        heldLine.hidden = !held;
        input.disabled = held;
        add.disabled = held || isFull;
      }
      next.hidden = held || queue.length === 0 || s.room?.itemId === undefined;
      if (pending.length > 0) {
        // A new current item answers an add only if the room had none at the send (my add started it, ADR 0031 §5);
        // otherwise it's someone else's share or advance.
        let answered = current === undefined && s.room?.itemId !== undefined ? 1 : 0;
        current = s.room?.itemId;
        for (const i of queue) {
          if (i.by !== null && i.by === s.self && !mine.has(i.id)) {
            mine.add(i.id);
            answered++;
          }
        }
        pending.splice(0, answered);
        while (pending[0] !== undefined && now() - pending[0].at > ADD_ANSWER_MS) pending.shift();
      }
      if (s.lastError !== shownError) {
        shownError = s.lastError;
        const answer = pending[0];
        const text = answer === undefined || s.lastError === null ? undefined : ADD_ERRORS[s.lastError.code];
        if (answer !== undefined && text !== undefined) {
          if (input.value === "") input.value = answer.url;
          pending.shift();
          claimed = s.lastError;
          say(text);
        }
      }
      return s.lastError !== null && s.lastError === claimed;
    },
  };
}
