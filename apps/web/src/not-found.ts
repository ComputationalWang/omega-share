// "Room not found" (OME-768, M9 W2). A room this page never got into that is unknown, deleted, taken down, or private
// without a working key: one screen, the same words for all of them, so it never tells a private room from no room. It
// offers "Go home" and the open rooms (`GET /rooms`, fetched once, on first show). Every server string goes in via textContent.
import * as v from "valibot";
import { RoomListResponseSchema, type RoomSummary } from "@omega/shared";
import { el, sprite } from "./controls/dom";

export interface NotFoundOptions {
  /** The server's HTTP origin. */
  readonly serverUrl: string;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface NotFound {
  readonly root: HTMLElement;
  /** Show the screen; the open rooms load the first time. */
  show(): void;
}

export function createNotFound(o: NotFoundOptions): NotFound {
  const root = el("div", { className: "room-full room-not-found", hidden: true }, "room-not-found");
  const home = el("a", { className: "enter", href: "/", textContent: "Go home" }, "not-found-home");
  const list = el("ul", { className: "room-list" }, "not-found-rooms");
  const state = el("p", { className: "not-found-state", role: "status" });
  const retry = el("button", { type: "button", className: "ui-button secondary", hidden: true }, "not-found-retry");
  retry.append(sprite("ui-icon-retry"), "Try again");
  const open = el("section", { className: "rooms-public" });
  open.append(el("h3", { textContent: "Open rooms" }), list, state, retry);
  root.append(
    el("h2", { textContent: "This room doesn't exist or was taken down" }),
    el("p", { textContent: "Check the link, or pick an open room. If someone sent you this link, ask them to send it again, exactly as it was." }),
    home,
    open,
  );

  const render = (rooms: readonly RoomSummary[]): void => {
    list.replaceChildren(
      // Ids are the wire's own (RoomIdSchema, parsed below): a path segment that can't climb out of /r/.
      ...rooms.map((r) => {
        const li = el("li");
        li.append(el("a", { href: `/r/${r.id}`, textContent: r.title ?? r.id }, "not-found-room"), el("span", { className: "count", textContent: ` ${String(r.memberCount)} here` }));
        return li;
      }),
    );
    state.textContent = list.childElementCount === 0 ? "No open rooms right now." : "";
  };

  let loading = false;
  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    retry.hidden = true;
    state.textContent = "Loading the open rooms…";
    try {
      const res = await o.fetch(`${o.serverUrl.replace(/\/+$/, "")}/rooms`, { credentials: "omit", cache: "no-store" });
      const parsed = v.safeParse(RoomListResponseSchema, await res.json());
      if (!parsed.success) throw new Error("bad room list");
      render(parsed.output.rooms);
    } catch {
      state.textContent = "Couldn't load the open rooms.";
      retry.hidden = false;
    } finally {
      loading = false;
    }
  };
  retry.addEventListener("click", () => {
    void load();
  });

  let shown = false;
  return {
    root,
    show() {
      root.hidden = false;
      if (shown) return;
      shown = true;
      void load();
    },
  };
}
