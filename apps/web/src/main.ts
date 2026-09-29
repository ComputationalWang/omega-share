// Landing: nickname + avatar + one Enter click (which also satisfies autoplay). Keep this entry tiny; the room loads on demand.
import type { Avatar } from "@omega/shared";
import { loadProfile, saveProfile, validateNickname } from "./profile";
import { roomIdFromPath, wsUrl } from "./route";
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
const options = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=avatar-option]")];

const roomId = roomIdFromPath(location.pathname);
const serverUrl = import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:8787`;
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
      roomRoot.hidden = false;
      return startRoom({ root: roomRoot, roomId, socketUrl: wsUrl(serverUrl, roomId), nickname: r.nickname, avatar });
    })
    .then((room) => {
      debug.room = room;
    })
    .catch((e: unknown) => {
      console.error(e);
      form.hidden = false;
      roomRoot.hidden = true;
      enter.disabled = false;
      error.textContent = "Could not open the room. Try again.";
    });
});

performance.mark("omega:interactive");
