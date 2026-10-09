// Landing: nickname + avatar + one Enter click (which also satisfies autoplay). Keep this entry tiny; the room loads on demand.
import { DEFAULT_ROOM_ID, type Avatar } from "@omega/shared";
import { loadProfile, saveProfile, validateNickname } from "./profile";
import { roomIdInPath, serverBaseUrl, wsUrl } from "./route";
import { loadRoomSecrets, secretFor, takeInviteKey, type SecretsStore } from "./room-secrets";
import type * as RoomModule from "./room";
import type { RoomHandle } from "./room";

declare global {
  interface Window {
    /** Dev/test builds only: live room state for QA. */
    __omega?: { readonly roomId: string; readonly room: RoomHandle | null };
  }
}

function must<T extends Element>(sel: string, type: new () => T): T {
  const e = document.querySelector(sel);
  if (!(e instanceof type)) throw new Error(`missing ${sel}`);
  return e;
}

const form = must("#landing", HTMLFormElement);
const input = must("#nickname", HTMLInputElement);
const error = must("#nickname-error", HTMLElement);
const enter = must("[data-testid=join-button]", HTMLButtonElement);
const roomRoot = must("#room-root", HTMLElement);
const homeRoot = must("#home-root", HTMLElement);
const options = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=avatar-option]")];

const pathRoom = roomIdInPath(location.pathname);
// The `localStorage` getter itself throws when storage is blocked; go through it lazily so the strip below still runs.
const storage: SecretsStore = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, value) => {
    localStorage.setItem(k, value);
  },
};
// First, before anything that can load a provider SDK (they all load from the room chunk, imported below): the Twitch
// SDK reads location.href, so a private room's `#k=` key is saved and dropped from the URL here (ADR 0028).
const invited = takeInviteKey(location, history, storage, pathRoom);
const roomId = pathRoom ?? DEFAULT_ROOM_ID;
const serverUrl = serverBaseUrl(import.meta.env.VITE_SERVER_URL, location, import.meta.env.DEV);
const debug = { roomId, room: null as RoomHandle | null };
if (import.meta.env.DEV) window.__omega = debug;

const profile = loadProfile(localStorage);
let avatar: Avatar = profile.avatar;
if (profile.nickname !== null) input.value = profile.nickname;

const selectAvatar = (a: Avatar): void => {
  avatar = a;
  for (const o of options) {
    const on = o.dataset["avatar"] === String(a);
    o.ariaChecked = String(on);
    o.tabIndex = on ? 0 : -1;
  }
};
selectAvatar(avatar);
options.forEach((o, i) => {
  o.addEventListener("click", () => {
    selectAvatar(i);
  });
});

// Warm the room chunk once the user shows intent, without competing with first paint.
let roomModule: Promise<typeof RoomModule> | null = null;
const loadRoom = (): Promise<typeof RoomModule> => (roomModule ??= import("./room"));
form.addEventListener("focusin", () => void loadRoom(), { once: true });
form.addEventListener("pointerover", () => void loadRoom(), { once: true });

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const r = validateNickname(input.value);
  if (!r.ok) {
    error.textContent = r.message;
    input.ariaInvalid = "true";
    input.focus();
    return;
  }
  error.textContent = "";
  input.ariaInvalid = "false";
  saveProfile(localStorage, { nickname: r.nickname, avatar });
  enter.disabled = true;
  void loadRoom()
    .then(({ startRoom }) => {
      form.hidden = true;
      homeRoot.hidden = true;
      roomRoot.hidden = false;
      return startRoom({
        root: roomRoot,
        roomId,
        socketUrl: wsUrl(serverUrl, roomId),
        nickname: r.nickname,
        avatar,
        secret: secretFor(loadRoomSecrets(storage), roomId, invited),
        secrets: storage,
        origin: location.origin,
        serverUrl,
      });
    })
    .then((room) => {
      debug.room = room;
    })
    .catch((e: unknown) => {
      console.error(e);
      form.hidden = false;
      homeRoot.hidden = pathRoom !== null;
      roomRoot.hidden = true;
      enter.disabled = false;
      error.textContent = "Could not open the room. Try again.";
    });
});

// The home page (not a room link) also gets the rooms panel: create, your rooms, open rooms. A lazy chunk after first paint.
if (pathRoom === null) {
  homeRoot.hidden = false;
  const mountHome = (): void => {
    void import("./home").then(({ mountHome }) =>
      mountHome({
        root: homeRoot,
        serverUrl,
        store: storage,
        fetch: (url, init) => fetch(url, init),
        navigate: (path) => {
          location.assign(path);
        },
      }),
    );
  };
  if (document.readyState === "complete") mountHome();
  else window.addEventListener("load", mountHome, { once: true });
}

performance.mark("omega:interactive");
