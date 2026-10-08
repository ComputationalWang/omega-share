import * as v from "valibot";
import {
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  ROOM_TITLE_MAX_LENGTH,
  RoomListResponseSchema,
  type CreateRoomErrorCode,
  type RoomId,
  type RoomSummary,
} from "@omega/shared";
import { el } from "./controls/dom";
import { forgetRoom, loadRoomSecrets, rememberRoom, type SecretsStore } from "./room-secrets";

// The home page's rooms panel (OME-409, ADR 0028): create a room, the rooms this browser holds secrets for, and the
// public list. A lazy chunk, so the landing's first paint doesn't wait for it. Plain UI; design set (i) skins it later.
// Every server string goes through textContent.

export interface HomeOptions {
  readonly root: HTMLElement;
  readonly serverUrl: string;
  readonly store: SecretsStore;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Opens a room page, e.g. `location.assign`. */
  readonly navigate: (path: string) => void;
}

export interface Home {
  /** Settles once the public list has loaded (or failed). */
  readonly ready: Promise<void>;
}

const ERRORS: Record<CreateRoomErrorCode, string> = {
  invalid_body: "That title can't be used. Letters, digits, spaces and simple punctuation only.",
  payload_too_large: "That title is too long.",
  rate_limited: "You've made a lot of rooms. Try again later.",
  too_many_rooms: "The server is full right now. Try again later.",
  unavailable: "The server couldn't save the room. Try again later.",
};
const NETWORK_ERROR = "Could not reach the server. Try again.";

function minutes(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  return m <= 1 ? "in a minute" : `in ${String(m)} min`;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function mountHome(opts: HomeOptions): Home {
  const base = opts.serverUrl.replace(/\/+$/, "");
  let titles = new Map<RoomId, string>();

  // Create.
  const form = el("form", { className: "create-room", noValidate: true }, "create-room-form");
  const title = el("input", { type: "text", id: "create-room-title", maxLength: ROOM_TITLE_MAX_LENGTH, required: true, autocomplete: "off" }, "create-room-title");
  const titleLabel = el("label", { htmlFor: title.id, textContent: "Room name" });
  const priv = el("input", { type: "checkbox", id: "create-room-private" }, "create-room-private");
  const privLabel = el("label", { htmlFor: priv.id, textContent: "Private (only people with the invite link can join)" });
  const submit = el("button", { type: "submit", className: "enter", textContent: "Create room" }, "create-room-submit");
  const error = el("p", { className: "error", ariaLive: "polite" }, "create-room-error");
  const check = el("div", { className: "check" });
  check.append(priv, privLabel);
  form.append(el("h2", { textContent: "Make a room" }), titleLabel, title, check, error, submit);

  const fail = (message: string): void => {
    error.textContent = message;
    submit.disabled = false;
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const req = v.safeParse(CreateRoomRequestSchema, { title: title.value, visibility: priv.checked ? "private" : "public" });
    if (!req.success) {
      fail(title.value.trim() === "" ? "Give the room a name." : ERRORS.invalid_body);
      title.focus();
      return;
    }
    error.textContent = "";
    submit.disabled = true;
    opts
      .fetch(`${base}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.output) })
      .then(readJson)
      .then((body) => {
        const r = v.safeParse(CreateRoomResponseSchema, body);
        if (!r.success) {
          fail(NETWORK_ERROR);
          return;
        }
        const res = r.output;
        if (!res.ok) {
          const wait = res.error.retryAfterMs;
          fail(res.error.code === "rate_limited" && wait !== undefined ? `You've made a lot of rooms. Try again ${minutes(wait)}.` : ERRORS[res.error.code]);
          return;
        }
        rememberRoom(opts.store, res.room.id, res.inviteKey === undefined ? { ownerToken: res.ownerToken } : { ownerToken: res.ownerToken, inviteKey: res.inviteKey });
        opts.navigate(`/r/${res.room.id}`);
      })
      .catch(() => {
        fail(NETWORK_ERROR);
      });
  });

  // Your rooms: ids and roles only, never a secret.
  const yours = el("ul", { className: "room-list" }, "your-rooms");
  const yoursSection = el("section", { className: "rooms-yours" });
  yoursSection.append(el("h2", { textContent: "Your rooms" }), yours);
  const renderYours = (): void => {
    const rooms = Object.entries(loadRoomSecrets(opts.store).rooms).reverse();
    yoursSection.hidden = rooms.length === 0;
    yours.replaceChildren(
      ...rooms.map(([id, secret]) => {
        const li = el("li", {}, "your-room");
        li.dataset["owner"] = String(secret.ownerToken !== undefined);
        const a = el("a", { href: `/r/${id}`, textContent: titles.get(id) ?? id }, "your-room-link");
        const forget = el("button", { type: "button", className: "link", textContent: "Forget" }, "your-room-forget");
        forget.addEventListener("click", () => {
          forgetRoom(opts.store, id);
          renderYours();
        });
        li.append(a, " ", el("span", { className: "role", textContent: secret.ownerToken !== undefined ? "owner" : "invited" }), " ", forget);
        return li;
      }),
    );
  };

  // Public rooms.
  const listed = el("ul", { className: "room-list" }, "public-rooms");
  const listedSection = el("section", { className: "rooms-public" });
  listedSection.append(el("h2", { textContent: "Open rooms" }), listed);
  const renderListed = (rooms: readonly RoomSummary[]): void => {
    listed.replaceChildren(
      ...rooms.map((r) => {
        const li = el("li");
        li.append(el("a", { href: `/r/${r.id}`, textContent: r.title ?? r.id }, "public-room-link"), el("span", { className: "count", textContent: ` ${String(r.memberCount)} here` }));
        return li;
      }),
    );
  };

  opts.root.replaceChildren(form, yoursSection, listedSection);
  renderYours();

  const ready = opts
    .fetch(`${base}/rooms`)
    .then(readJson)
    .then((body) => {
      const r = v.safeParse(RoomListResponseSchema, body);
      const rooms = r.success ? r.output.rooms : [];
      titles = new Map(rooms.flatMap((x) => (x.title === undefined ? [] : [[x.id, x.title] as const])));
      renderListed(rooms);
      renderYours();
    })
    .catch(() => {
      renderListed([]);
    });
  return { ready };
}
