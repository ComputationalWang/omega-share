// Landing: nickname + avatar + one Enter click (which also satisfies autoplay). Keep this entry tiny; the room loads on demand.
// Three views on one page (Dusk doorstep, OME-935): entry (the form), directory (find or make a room, `/` only) and room.
// `<html data-view>` scopes the site styles to entry/directory, so the room's own layouts never see them.
import { DEFAULT_ROOM_ID, type Avatar, type Nickname, type ResumeToken } from "@omega/shared";
import { loadProfile, saveProfile, validateNickname } from "./profile";
import { roomIdInPath, serverBaseUrl, wsUrl } from "./route";
import { loadRoomSecrets, secretFor, takeInviteKey, type SecretsStore } from "./room-secrets";
import { loadResume } from "./session-record";
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
const welcome = must(".welcome", HTMLElement);
const findRoom = must("[data-testid=find-room]", HTMLButtonElement);
const editProfile = must("[data-testid=edit-profile]", HTMLButtonElement);
const directoryTitle = must("#directory-title", HTMLElement);
const greeting = must("#directory-greeting", HTMLElement);
const directory = must("#directory", HTMLElement);
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
// The test handle: dev builds, and the perf runner's build (VITE_TEST_HANDLE=1) so its harness can send leave (ADR 0043).
// Inline on purpose: Vite turns both into literals and a production build drops the line (OME-1007).
if (import.meta.env.DEV || import.meta.env.VITE_TEST_HANDLE === "1") window.__omega = debug;

type View = "entry" | "directory" | "room";
const show = (view: View): void => {
  document.documentElement.dataset["view"] = view;
  welcome.hidden = view !== "entry";
  form.hidden = view !== "entry";
  homeRoot.hidden = view !== "directory";
  roomRoot.hidden = view !== "room";
};
// A room link enters that room; only the home page offers the directory.
enter.textContent = pathRoom === null ? "Enter lobby" : "Enter room";
findRoom.hidden = pathRoom !== null;

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

// Warm the room chunk once the user shows intent, without competing with first paint. On a room link that is anything in
// the entry form (the room is the only way on). On the home page only Enter lobby is: a nickname typed on the way to the
// directory must not fetch the renderer (OME-934 compatibility contract).
let roomModule: Promise<typeof RoomModule> | null = null;
const loadRoom = (): Promise<typeof RoomModule> => (roomModule ??= import("./room"));
const intent: HTMLElement = pathRoom === null ? enter : form;
intent.addEventListener("focusin", () => void loadRoom(), { once: true });
intent.addEventListener("pointerover", () => void loadRoom(), { once: true });

/** Checks the nickname field; on failure says why and puts focus back in it. */
const checkedNickname = (): Nickname | null => {
  const r = validateNickname(input.value);
  if (!r.ok) {
    error.textContent = r.message;
    input.ariaInvalid = "true";
    input.focus();
    return null;
  }
  error.textContent = "";
  input.ariaInvalid = "false";
  return r.nickname;
};

/** Into the room: from Enter, or straight from this tab's stored session for the room (ADR 0043). */
const enterRoom = (nickname: Nickname, as: Avatar, resumeToken?: ResumeToken): void => {
  enter.disabled = true;
  void loadRoom()
    .then(({ startRoom }) => {
      show("room");
      return startRoom({
        root: roomRoot,
        roomId,
        socketUrl: wsUrl(serverUrl, roomId),
        nickname,
        avatar: as,
        ...(resumeToken === undefined ? {} : { resumeToken }),
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
      show("entry");
      enter.disabled = false;
      error.textContent = "Could not open the room. Try again.";
    });
};

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const nickname = checkedNickname();
  if (nickname === null) return;
  saveProfile(localStorage, { nickname, avatar });
  enterRoom(nickname, avatar);
});

// Back in a room this tab was in (reload, restore, return): no Enter form, the stored session rejoins the same member.
// sessionStorage, not localStorage, so a second tab never shares it (ADR 0043). Blocked storage reads as no record.
const resumed =
  pathRoom === null
    ? null
    : loadResume({ getItem: (k) => sessionStorage.getItem(k), setItem: (k, value) => { sessionStorage.setItem(k, value); }, removeItem: (k) => { sessionStorage.removeItem(k); } }, pathRoom);
if (resumed !== null) {
  // Straight back in: no entry form while the room loads.
  document.documentElement.dataset["view"] = "room";
  welcome.hidden = true;
  form.hidden = true;
  input.value = resumed.nickname;
  selectAvatar(resumed.avatar);
  enterRoom(resumed.nickname, resumed.avatar, resumed.token);
}

// The home page (not a room link) also gets the directory: create, your rooms, open rooms. A lazy chunk, with the preset
// thumbnails: never on a first visit's load (OME-1022), warmed by intent in the entry form, at once when a returning
// profile lands on the directory or asks for it.
if (pathRoom === null) {
  let mounted = false;
  const mountHome = (): void => {
    if (mounted) return;
    mounted = true;
    void Promise.all([import("./home"), import("./preset-thumbs")]).then(([{ mountHome }, { PRESET_THUMBS }]) =>
      mountHome({
        root: directory,
        serverUrl,
        store: storage,
        // The `sessionStorage` getter itself throws when storage is blocked; stashPendingLayout catches it.
        session: { setItem: (k, value) => { sessionStorage.setItem(k, value); } },
        thumbs: PRESET_THUMBS,
        fetch: (url, init) => fetch(url, init),
        navigate: (path) => {
          location.assign(path);
        },
      }),
    );
  };
  // Welcome back only to a profile this browser already held when the page loaded.
  const returning = profile.nickname !== null;
  const openDirectory = (nickname: Nickname): void => {
    greeting.textContent = `${returning ? "Welcome back" : "Welcome"}, ${nickname}`;
    show("directory");
    mountHome();
  };
  findRoom.addEventListener("click", () => {
    const nickname = checkedNickname();
    if (nickname === null) return;
    saveProfile(localStorage, { nickname, avatar });
    openDirectory(nickname);
    directoryTitle.focus();
  });
  editProfile.addEventListener("click", () => {
    show("entry");
    input.focus();
  });
  // The quick links move focus to their target (a fragment jump alone only scrolls), and keep `#…` out of the URL.
  for (const a of homeRoot.querySelectorAll<HTMLAnchorElement>(".jump a")) {
    a.addEventListener("click", (ev) => {
      const target = document.getElementById(a.hash.slice(1));
      if (target === null) return;
      ev.preventDefault();
      target.focus();
      target.scrollIntoView({ block: "start" });
    });
  }
  if (profile.nickname !== null && resumed === null) openDirectory(profile.nickname);
  else {
    for (const target of [form, findRoom]) {
      target.addEventListener("focusin", mountHome, { once: true });
      target.addEventListener("pointerover", mountHome, { once: true });
    }
  }
} else if (resumed === null) show("entry");

performance.mark("omega:interactive");
