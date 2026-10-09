// The "Up next" panel (ADR 0031, set j `.ui-queue`): the room's upcoming items, a paste-a-link field and the keys to remove
// one or play the next now. Everything here is text: titles come from the parsed embed's ids, names from `members`, and no
// row ever loads anything (a generic item stays click-to-load on the TV, ADR 0024). The list is rebuilt only when the queue,
// the members or who may act change: room.ts calls `update` once per state change, and an unchanged input costs a few compares.
import { QUEUE_MAX, canonicalizeAnyEmbed, isSyncedEmbed, normalizeHostname, type AnyEmbed, type ClientMessage, type ErrorCode, type MemberId, type QueueItem } from "@omega/shared";
import { controlHeld, type ViewState } from "../state";
import { el, sprite } from "./dom";

export interface QueuePanelOptions {
  readonly send: (m: ClientMessage) => boolean;
  /** This site's hostnames: a link to them is refused with its own reason (the server refuses it too, ADR 0024). */
  readonly ownHosts: readonly string[];
}

export interface QueuePanel {
  readonly root: HTMLElement;
  /** After every state change. Rebuilds the rows only when the queue, the members or the permissions changed. */
  update(s: ViewState): void;
  /** How many times the rows were rebuilt (the "once per change" test and e2e). */
  renders(): number;
}

/** Head sprites by avatar index (assets/README.md set j `head/*`: juno, pip, mo, kiki). */
const HEADS = ["juno", "pip", "mo", "kiki"] as const;

const NOT_A_LINK = "That isn't a link. Paste the address of a video page.";
const CANT_PLAY = "That link can't play here. Try a video page's https link.";
const OWN_SITE = "That's a link to this site. Paste a video page's link.";
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
  root.append(head, empty, list, form, problem, full, heldLine);

  let state: ViewState | null = null;
  let drawnQueue: readonly QueueItem[] | undefined;
  let drawnMembers: unknown;
  let drawnKey = "";
  let renders = 0;
  let shownError: ViewState["lastError"] = null;
  /** The link of an add the server hasn't answered yet: an error then is about it, and puts it back in the field. */
  let pending: string | null = null;

  const say = (text: string | null): void => {
    problem.hidden = text === null;
    problem.lastChild?.replaceWith(el("span", { textContent: text ?? "" }));
    input.setAttribute("aria-invalid", String(text !== null));
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
    pending = url;
    input.value = "";
    say(null);
  });
  next.addEventListener("click", () => {
    const from = state?.room?.itemId;
    if (from !== undefined) o.send({ type: "queue-advance", fromItemId: from });
  });
  list.addEventListener("click", (ev) => {
    if (!(ev.target instanceof HTMLElement)) return;
    const id = ev.target.closest<HTMLElement>("[data-testid=queue-remove]")?.closest<HTMLElement>("[data-item]")?.dataset["item"];
    if (id !== undefined) o.send({ type: "queue-remove", itemId: id });
  });

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
      const x = el("button", { type: "button", className: "ui-sprite ui-qx" }, "queue-remove");
      x.setAttribute("aria-label", `Remove ${title} from the queue`);
      li.append(x);
    }
    return li;
  };

  return {
    root,
    renders: () => renders,
    update(s) {
      state = s;
      const queue = s.room?.queue ?? [];
      const held = controlHeld(s);
      const key = `${String(held)}|${String(s.owner)}|${s.self ?? ""}`;
      if (queue !== drawnQueue || s.room?.members !== drawnMembers || key !== drawnKey) {
        // The list moved on (most likely with our item): an error after this isn't the add's.
        if (queue !== drawnQueue) pending = null;
        drawnQueue = queue;
        drawnMembers = s.room?.members;
        drawnKey = key;
        renders++;
        const canRemove = (by: MemberId | null): boolean => !held && (s.owner || (by !== null && by === s.self));
        list.replaceChildren(...queue.map((it, i) => row(it, i, s, canRemove)));
        count.textContent = `${String(queue.length)} / ${String(QUEUE_MAX)}`;
        empty.hidden = queue.length > 0;
        const isFull = queue.length >= QUEUE_MAX;
        full.hidden = !isFull || held;
        heldLine.hidden = !held;
        input.disabled = held;
        add.disabled = held || isFull;
      }
      next.hidden = held || queue.length === 0 || s.room?.itemId === undefined;
      if (s.lastError !== shownError) {
        shownError = s.lastError;
        const text = s.lastError === null || pending === null ? undefined : ADD_ERRORS[s.lastError.code];
        if (text !== undefined) {
          if (input.value === "" && pending !== null) input.value = pending;
          pending = null;
          say(text);
        }
      }
    },
  };
}
