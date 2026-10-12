import * as v from "valibot";
import {
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  ROOM_TITLE_MAX_LENGTH,
  RoomListResponseSchema,
  type CreateRoomErrorCode,
  type RoomId,
  type RoomLayout,
  type RoomPresetId,
  type RoomSummary,
} from "@omega/shared";
import { el } from "./controls/dom";
import { stashPendingLayout, type PendingStore } from "./pending-layout";
import { DEFAULT_PRESET, PRESETS, PRESET_THUMB } from "./presets";
import { forgetRoom, loadRoomSecrets, rememberRoom, type SecretsStore } from "./room-secrets";
import { deleteSavedLayout, loadSavedLayouts, type LayoutStore } from "./saved-layouts";

// The home page's rooms panel (OME-409, ADR 0028): create a room, the rooms this browser holds secrets for, and the
// public list. A lazy chunk, so the landing's first paint doesn't wait for it. Plain UI; design set (i) skins it later.
// Every server string goes through textContent.

export interface HomeOptions {
  readonly root: HTMLElement;
  readonly serverUrl: string;
  readonly store: SecretsStore & LayoutStore;
  /** Where a chosen saved layout waits for the room page (sessionStorage). */
  readonly session: Pick<PendingStore, "setItem">;
  /** The preset thumbnails as URLs (preset-thumbs.ts, so this file stays free of bundler-only imports). */
  readonly thumbs: Readonly<Record<RoomPresetId, string>>;
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
const SAVED_GONE = "That saved layout isn't there any more. Pick another.";
const SAVED_PREFIX = "saved:";
const NETWORK_ERROR = "Could not reach the server. Try again.";
const STORAGE_ERROR = "This browser won't keep the room's keys (site storage is blocked or full), so you couldn't manage or rejoin it. Allow storage for this site and try again.";

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

  // Layout: the presets (native radios: one tab stop, arrows move) and, below, the owner's own saved layouts. One
  // `name="preset"` group, so there is one choice across both. The server resolves the id; only a saved layout also
  // waits in sessionStorage for the room page to send it (pending-layout.ts).
  const picker = el("fieldset", { className: "preset-picker" }, "preset-picker");
  picker.append(el("legend", { textContent: "Room layout" }));
  const presetList = el("div", { className: "preset-list" });
  for (const p of PRESETS) {
    const label = el("label", { className: "preset" });
    const radio = el("input", { type: "radio", name: "preset", value: p.id, checked: p.id === DEFAULT_PRESET }, `preset-${p.id}`);
    const img = el("img", { src: opts.thumbs[p.id], alt: "", width: PRESET_THUMB.w, height: PRESET_THUMB.h, loading: "lazy", decoding: "async" });
    label.append(radio, img, el("span", { className: "preset-name", textContent: p.name }), el("span", { className: "preset-blurb", textContent: p.blurb }));
    presetList.append(label);
  }
  picker.append(presetList);
  const savedSlot = el("div", { className: "saved-slot" });
  const defaultRadio = (): HTMLInputElement | null => {
    const r = picker.querySelector(`input[value="${DEFAULT_PRESET}"]`);
    return r instanceof HTMLInputElement ? r : null;
  };
  const renderSaved = (): void => {
    const list = loadSavedLayouts(opts.store);
    if (list.length === 0) {
      savedSlot.replaceChildren();
      return;
    }
    const group = el("fieldset", { className: "saved-layouts" }, "saved-layouts");
    group.append(el("legend", { textContent: "Your layouts" }));
    for (const item of list) {
      const row = el("div", { className: "saved-item" }, "saved-layout");
      const label = el("label", { className: "saved-name" });
      const radio = el("input", { type: "radio", name: "preset", value: `${SAVED_PREFIX}${item.name}` }, "saved-layout-radio");
      label.append(radio, el("span", { textContent: item.name }));
      const del = el("button", { type: "button", className: "link", textContent: "Delete", ariaLabel: `Delete layout ${item.name}` }, "saved-layout-delete");
      del.addEventListener("click", () => {
        const wasChosen = radio.checked;
        deleteSavedLayout(opts.store, item.name);
        renderSaved();
        if (wasChosen) {
          const d = defaultRadio();
          if (d !== null) d.checked = true;
        }
      });
      row.append(label, del);
      group.append(row);
    }
    savedSlot.replaceChildren(group);
  };
  renderSaved();
  form.append(el("h2", { textContent: "Make a room" }), titleLabel, title, picker, savedSlot, check, error, submit);

  const fail = (message: string): void => {
    error.textContent = message;
    submit.disabled = false;
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const chosen = [...form.querySelectorAll("input[name=preset]")].find((r): r is HTMLInputElement => r instanceof HTMLInputElement && r.checked)?.value ?? DEFAULT_PRESET;
    let pending: RoomLayout | null = null;
    if (chosen.startsWith(SAVED_PREFIX)) {
      const name = chosen.slice(SAVED_PREFIX.length);
      pending = loadSavedLayouts(opts.store).find((s) => s.name === name)?.layout ?? null;
      if (pending === null) {
        renderSaved();
        fail(SAVED_GONE);
        return;
      }
    }
    const req = v.safeParse(CreateRoomRequestSchema, { title: title.value, visibility: priv.checked ? "private" : "public", preset: pending === null ? chosen : "empty" });
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
        const saved = rememberRoom(opts.store, res.room.id, res.inviteKey === undefined ? { ownerToken: res.ownerToken } : { ownerToken: res.ownerToken, inviteKey: res.inviteKey });
        // Without its secrets the room can't be managed, and a private one can't even be joined: say so, don't go.
        if (!saved) {
          fail(STORAGE_ERROR);
          return;
        }
        // A saved layout waits for the room page. If the tab's storage is blocked the room is simply the empty preset.
        if (pending !== null) stashPendingLayout(opts.session, res.room.id, pending);
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
  const armed = new Set<string>();
  const renderYours = (): void => {
    const rooms = Object.entries(loadRoomSecrets(opts.store).rooms).reverse();
    yoursSection.hidden = rooms.length === 0;
    yours.replaceChildren(
      ...rooms.map(([id, secret]) => {
        const li = el("li", {}, "your-room");
        li.dataset["owner"] = String(secret.ownerToken !== undefined);
        const a = el("a", { href: `/r/${id}`, textContent: titles.get(id) ?? id }, "your-room-link");
        const owner = secret.ownerToken !== undefined;
        const forget = el("button", { type: "button", className: "link", textContent: "Forget" }, "your-room-forget");
        // The owner token can't be recovered (research §2.4), so forgetting a room you own takes a second click.
        // Armed rooms live outside the render: the GET /rooms reply re-renders, and must not disarm a first click.
        const confirm = (): void => {
          forget.textContent = "Forget for good? You can't undo this";
        };
        if (armed.has(id)) confirm();
        forget.addEventListener("click", () => {
          if (owner && !armed.has(id)) {
            armed.add(id);
            confirm();
            return;
          }
          armed.delete(id);
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
