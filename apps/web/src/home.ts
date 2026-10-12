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

// The home page's room directory (OME-409, ADR 0028; Dusk doorstep redesign OME-935): create a room, the rooms this
// browser holds secrets for, and the public list. A lazy chunk, so the landing's first paint doesn't wait for it.
// Every server string goes through textContent. The public list tells loading, empty and unreachable apart.

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
const SUBMIT_LABEL = "Create room";
const SUBMITTING_LABEL = "Creating room…";
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
  let counts = new Map<RoomId, number>();

  // Create.
  const form = el("form", { className: "create-room", noValidate: true }, "create-room-form");
  const title = el("input", { type: "text", id: "create-room-title", maxLength: ROOM_TITLE_MAX_LENGTH, required: true, autocomplete: "off" }, "create-room-title");
  const titleLabel = el("label", { htmlFor: title.id, textContent: "Room name" });
  const priv = el("input", { type: "checkbox", id: "create-room-private" }, "create-room-private");
  const privLabel = el("label", { htmlFor: priv.id, textContent: "Private · only people with the invite link can join" });
  const submit = el("button", { type: "submit", className: "enter", textContent: SUBMIT_LABEL }, "create-room-submit");
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
  title.placeholder = "Friday film night";
  form.append(el("h2", { textContent: "Make a room" }), titleLabel, title, picker, savedSlot, check, error, submit, el("p", { className: "note", textContent: "Share the link once you're inside." }));

  const fail = (message: string): void => {
    error.textContent = message;
    submit.disabled = false;
    submit.textContent = SUBMIT_LABEL;
    title.focus();
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
    submit.textContent = SUBMITTING_LABEL;
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
  const yoursEmpty = el("p", { className: "list-note", textContent: "No saved rooms in this browser yet." }, "your-rooms-empty");
  const yoursSection = el("section", { className: "rooms-yours" });
  yoursSection.append(el("h2", { textContent: "Your rooms" }), yours);
  const armed = new Set<string>();
  const renderYours = (): void => {
    const rooms = Object.entries(loadRoomSecrets(opts.store).rooms).reverse();
    if (rooms.length === 0) yours.after(yoursEmpty);
    else yoursEmpty.remove();
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
        const info = el("div", { className: "room-info" });
        const meta = el("p", { className: "room-meta" });
        meta.append(secret.inviteKey === undefined ? "Public" : "Private", " · ", el("span", { className: "role", textContent: owner ? "owner" : "invited" }), " · saved in this browser");
        info.append(a, meta);
        const here = counts.get(id);
        li.append(info, el("span", { className: "count", textContent: here === undefined ? "" : `${String(here)} here` }), forget);
        return li;
      }),
    );
  };

  // Public rooms.
  const listed = el("ul", { className: "room-list" }, "public-rooms");
  const listedHeading = el("h2", { id: "open-rooms", tabIndex: -1, textContent: "Open rooms" });
  // Polite, so loading → loaded/empty/unreachable is announced; the Retry key sits beside it, a real button.
  const listedStatus = el("p", { className: "list-note", role: "status" }, "public-rooms-status");
  const retry = el("button", { type: "button", className: "link retry", textContent: "Retry" }, "public-rooms-retry");
  const listedSection = el("section", { className: "rooms-public" });
  listedSection.append(listedHeading, listed, listedStatus, el("p", { className: "note", textContent: "Have an invite? Open its link to join a private room." }));
  const renderListed = (rooms: readonly RoomSummary[]): void => {
    listed.replaceChildren(
      ...rooms.map((r) => {
        const li = el("li");
        const info = el("div", { className: "room-info" });
        info.append(el("a", { href: `/r/${r.id}`, textContent: r.title ?? r.id }, "public-room-link"), el("p", { className: "room-meta", textContent: "Public room" }));
        li.append(info, el("span", { className: "count", textContent: `${String(r.memberCount)} here` }));
        return li;
      }),
    );
  };
  const listState = (state: "loading" | "loaded" | "failed", rooms: readonly RoomSummary[] = []): void => {
    listed.setAttribute("aria-busy", String(state === "loading"));
    listed.classList.toggle("is-loading", state === "loading");
    retry.remove();
    if (state === "loading") listedStatus.textContent = "Finding rooms…";
    else if (state === "failed") {
      listedStatus.textContent = NETWORK_ERROR;
      listedStatus.after(retry);
    } else listedStatus.textContent = rooms.length === 0 ? "No public rooms right now." : "";
  };

  opts.root.replaceChildren(form, yoursSection, listedSection);
  renderYours();

  const load = (): Promise<void> => {
    listState("loading");
    renderListed([]);
    return opts
      .fetch(`${base}/rooms`)
      .then(readJson)
      .then((body) => {
        const r = v.safeParse(RoomListResponseSchema, body);
        if (!r.success) {
          listState("failed");
          return;
        }
        const rooms = r.output.rooms;
        titles = new Map(rooms.flatMap((x) => (x.title === undefined ? [] : [[x.id, x.title] as const])));
        counts = new Map(rooms.map((x) => [x.id, x.memberCount] as const));
        renderListed(rooms);
        listState("loaded", rooms);
        renderYours();
      })
      .catch(() => {
        listState("failed");
      });
  };
  retry.addEventListener("click", () => {
    void load().then(() => {
      // Keep focus somewhere useful: back on Retry if it failed again, else on the list's heading.
      (retry.isConnected ? retry : listedHeading).focus();
    });
  });
  return { ready: load() };
}
