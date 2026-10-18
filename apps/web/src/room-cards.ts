// The cards that take the room's place once the connection has stopped (full, refused, closed, removed, replaced, not
// found), and the guest's "Report this room" foot. Split out of room.ts (OME-1100); each one shows from the view state.
import type { RoomId } from "@omega/shared";
import { el } from "./controls/dom";
import { kickedCard, refusalCard } from "./controls/feedback";
import { createNotFound } from "./not-found";
import { createReport } from "./report/dialog";
import { forgetRoom, type SecretsStore } from "./room-secrets";
import { screen, type Refusal, type ViewState } from "./state";

export interface RoomCardsOptions {
  readonly roomId: RoomId;
  readonly serverUrl: string;
  /** Where `omega.rooms` lives: a closed room is forgotten. */
  readonly secrets: SecretsStore;
  /** This browser owns the room: an owner never reports their own room, so no report key is made. */
  readonly owns: boolean;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The report dialog's "Leave the room". */
  readonly leave: () => void;
  /** "Return here" on the replaced card. */
  readonly reclaim: () => void;
}

export interface RoomCards {
  /** The cards in page order: full, refused, closed, not found, removed, replaced. */
  readonly cards: readonly HTMLElement[];
  readonly foot: HTMLElement;
  readonly reportOpen: () => boolean;
  readonly render: (s: ViewState) => void;
}

export function createRoomCards(o: RoomCardsOptions): RoomCards {
  const full = el("div", { className: "room-full", hidden: true }, "room-full");
  full.append(el("h2", { textContent: "This room is full" }), el("p", { textContent: "Try again in a little while." }));
  // Refused join (nickname_taken, too_many_members, invite_required): the connection has stopped. Back to the landing to retry.
  const refused = el("div", { className: "room-full", hidden: true }, "room-refused");
  const refusedTitle = el("h2");
  const refusedBody = el("p");
  const refusedAction = el("a", { className: "enter", href: location.pathname }, "room-refused-action");
  refused.append(refusedTitle, refusedBody, refusedAction);
  let shownRefusal: Refusal | null = null;
  // 4004: the room was deleted or collected; 4006: the operators took it down after a report (ADR 0033 §6). The connection
  // has stopped; nothing here can bring it back.
  const closed = el("div", { className: "room-full", hidden: true }, "room-closed");
  const closedBody = el("p");
  const closedHome = el("a", { className: "enter", href: "/", textContent: "Go to the home page" });
  closed.append(el("h2", { textContent: "This room was closed" }), closedBody, closedHome);
  // Unknown, deleted, taken down, or private without a working key, and never got in (OME-768): one screen for all of them.
  const notFound = createNotFound({ serverUrl: o.serverUrl, fetch: o.fetch, referrer: document.referrer, origin: location.origin, path: location.pathname });
  // "Report this room" (OME-601, ADR 0033): a guest's quiet key, the last stop of the room. Not made at all in a room you own.
  const report = o.owns ? null : createReport({ roomId: o.roomId, serverUrl: o.serverUrl, fetch: o.fetch, leave: o.leave });
  const foot = el("div", { className: "room-foot", hidden: true }, "room-foot");
  if (report !== null) foot.append(report.key, report.dialog);
  // 4005: the owner removed us (ADR 0030). The connection has stopped; Rejoin waits out the cooldown, then reloads.
  const kicked = el("div", { className: "room-full", hidden: true }, "room-kicked");
  const kickedTitle = el("h2");
  const kickedBody = el("p");
  const rejoinIcon = el("span", { className: "ui-sprite ui-wait", ariaHidden: "true" });
  const rejoinText = el("span");
  const rejoin = el("button", { type: "button", className: "ui-button" }, "room-kicked-rejoin");
  rejoin.append(rejoinIcon, rejoinText);
  rejoin.addEventListener("click", () => {
    if (rejoin.getAttribute("aria-disabled") !== "true") location.reload();
  });
  kicked.append(
    el("span", { className: "ui-scene ui-scene-removed", ariaHidden: "true" }),
    kickedTitle,
    kickedBody,
    rejoin,
    el("a", { className: "enter secondary", href: "/", textContent: "Find a room" }),
  );
  // 4007 (ADR 0043): this session went on in another tab. Nothing reconnects by itself; "Return here" takes it back.
  const replacedCard = el("div", { className: "room-full", hidden: true }, "room-replaced");
  const reclaim = el("button", { type: "button", className: "ui-button" }, "room-replaced-return");
  reclaim.textContent = "Return here";
  replacedCard.append(
    el("h2", { textContent: "This session is open in another tab" }),
    el("p", { textContent: "You can keep watching there, or bring the room back to this tab." }),
    reclaim,
  );
  reclaim.addEventListener("click", o.reclaim);
  let kickedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fill the card for now and re-arm for the next minute; once the cooldown is over Rejoin is a plain key. */
  const renderKicked = (until: number | null): void => {
    if (kickedTimer !== null) clearTimeout(kickedTimer);
    kickedTimer = null;
    const card = kickedCard(until, Date.now());
    kickedTitle.textContent = card.title;
    kickedBody.textContent = card.body;
    rejoinText.textContent = card.rejoin;
    rejoin.classList.toggle("is-waiting", !card.ready);
    rejoinIcon.hidden = card.ready;
    if (card.ready) rejoin.removeAttribute("aria-disabled");
    else rejoin.setAttribute("aria-disabled", "true");
    // The dial runs once over what's left of the cooldown (set f's .ui-wait).
    if (until !== null) rejoinIcon.style.setProperty("--cool", `${String(Math.max(0, until - Date.now()))}ms`);
    if (card.nextChangeMs !== null) kickedTimer = setTimeout(() => { renderKicked(until); }, card.nextChangeMs);
  };

  const render = (s: ViewState): void => {
    const shown = screen(s);
    if (shown.notFound && notFound.root.hidden) {
      notFound.show();
      // A room this browser held keys for that no longer lets us in: nothing left to keep.
      forgetRoom(o.secrets, o.roomId);
    }
    full.hidden = !shown.full;
    refused.hidden = shown.refused === null;
    const isReplaced = s.status === "replaced";
    if (replacedCard.hidden === isReplaced) {
      replacedCard.hidden = !isReplaced;
      if (isReplaced) reclaim.focus({ preventScroll: true });
    }
    if (kicked.hidden === shown.kicked) {
      kicked.hidden = !shown.kicked;
      if (shown.kicked) renderKicked(s.kickedUntil);
    }
    const isClosed = shown.closed !== false;
    if (closed.hidden === isClosed) {
      closed.hidden = !isClosed;
      if (shown.closed !== false) {
        closed.dataset["reason"] = shown.closed;
        closedBody.textContent = shown.closed === "taken-down" ? "This room was closed by the omega-share team after a report." : "Its owner deleted it, or nobody used it for a long time.";
        forgetRoom(o.secrets, o.roomId);
      }
    }
    // Nothing left to report once the room is gone, and an owner never reports their own room.
    const footShown = report !== null && !isClosed && !s.owner;
    if (foot.hidden === footShown) {
      foot.hidden = !footShown;
      if (!footShown && report?.isOpen() === true) {
        report.close();
        // The key went with the foot: focus moves to the card in its place, not to <body> (QA OME-640).
        if (isClosed) closedHome.focus({ preventScroll: true });
      }
    }
    if (shown.refused !== shownRefusal) {
      shownRefusal = shown.refused;
      if (shown.refused !== null) {
        const card = refusalCard(shown.refused);
        refusedTitle.textContent = card.title;
        refusedBody.textContent = card.body;
        refusedAction.textContent = card.action;
        refused.dataset["code"] = shown.refused;
      }
    }
  };

  return { cards: [full, refused, closed, notFound.root, kicked, replacedCard], foot, reportOpen: () => report?.isOpen() === true, render };
}
