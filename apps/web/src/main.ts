// Landing: nickname + avatar + one Enter click (which also satisfies autoplay). Keep this entry tiny; the room loads on demand.
// Three views on one page (Dusk doorstep, OME-935): entry (the form), directory (find or make a room, `/` only) and room.
// `<html data-view>` scopes the site styles to entry/directory, so the room's own layouts never see them.
import { DEFAULT_ROOM_ID, type Accessory, type Avatar, type Hair, type Nickname, type ResumeToken, type Tint } from "@omega/shared";
import { createExtensionBridge } from "./extension-bridge";
import { SITE_TITLE } from "./page-title";
import tintsJson from "../../../assets/avatars/tints.json";
import { bindRadioRow, bindTintRow } from "./controls/tint-row";
import { loadProfile, saveAccessory, saveHair, saveProfile, saveTint, validateNickname } from "./profile";
import { roomIdInPath, serverBaseUrl, wsUrl } from "./route";
import { loadRoomSecrets, secretFor, takeInviteKey, type SecretsStore } from "./room-secrets";
import { mountRejoinChip } from "./rejoin-chip";
import { loadResume, takeHandOff, takeLeft, takePendingEnter } from "./session-record";
import { takeShareLink } from "./share-link";
import { AVATAR_HAIRS, AVATAR_IDS, parseTints } from "./walk/tint";
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
const avatarGroup = must(".avatars", HTMLElement);
const options = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=avatar-option]")];
const tintGroup = must("[data-testid=tint-row]", HTMLElement);
const hairGroup = must("[data-testid=hair-row]", HTMLElement);
const accessoryGroup = must("[data-testid=accessory-row]", HTMLElement);

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
// Likewise the extension's `#share=` link (OME-1085, ADR 0049): out of the URL at once; the home chunk validates it.
const shareLink = takeShareLink(location, history);
const roomId = pathRoom ?? DEFAULT_ROOM_ID;
const serverUrl = serverBaseUrl(import.meta.env.VITE_SERVER_URL, location, import.meta.env.DEV);
// Before the room chunk loads: the extension says `present` once, at page load (ADR 0047 §5).
const extension = createExtensionBridge(window);
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
  // The room writes its own title (OME-1238).
  if (view !== "room") document.title = `${view === "entry" ? "Pick a nickname" : "Find or create a room"} · ${SITE_TITLE}`;
};
// A room link enters that room; only the home page offers the directory.
enter.textContent = pathRoom === null ? "Enter lobby" : "Enter room";
findRoom.hidden = pathRoom !== null;

const profile = loadProfile(localStorage);
let avatar: Avatar = profile.avatar;
// Never picked one: the room swaps the preselected draw for its least-used avatar (OME-2131), and none is saved.
let avatarAuto = profile.avatarAuto;
let tint: Tint = profile.tint;
let accessory: Accessory = profile.accessory;
let hair: Hair = profile.hair;
if (profile.nickname !== null) input.value = profile.nickname;

// Shirt tint (ADR 0053): the row under the avatars shows the chosen avatar's ramps; a pick is saved at once.
const tints = parseTints(tintsJson, AVATAR_IDS);
const tintRow = bindTintRow(tintGroup, (t) => {
  tint = t;
  saveTint(storage, t);
});
// Hair colour (OME-1438), beside the tints: the same row on the avatar's hair ramps.
const hairRow = bindTintRow(hairGroup, (h) => {
  hair = h;
  saveHair(storage, h);
});
// The accessory (OME-1391), under the tints; saved at once and sent with join. The row is static markup (index.html).
bindRadioRow(accessoryGroup, (a) => {
  accessory = a;
  saveAccessory(storage, a);
}).check(accessory);

const selectAvatar = (a: Avatar): void => {
  avatar = a;
  tintRow.show(tints[a]?.tints ?? [], tint);
  hairRow.show(AVATAR_HAIRS[a]?.hairs ?? [], hair);
  for (const o of options) {
    const on = o.dataset["avatar"] === String(a);
    o.ariaChecked = String(on);
    o.tabIndex = on ? 0 : -1;
  }
};
selectAvatar(avatar);
options.forEach((o, i) => {
  o.addEventListener("click", () => {
    avatarAuto = false;
    selectAvatar(i);
  });
});
// The radiogroup's keys (WAI-ARIA radio pattern): arrows move the choice and wrap, Home and End go to the ends.
const AVATAR_KEYS: Readonly<Record<string, (i: number, n: number) => number>> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i + n - 1) % n,
  ArrowUp: (i, n) => (i + n - 1) % n,
  Home: () => 0,
  End: (_, n) => n - 1,
};
avatarGroup.addEventListener("keydown", (ev) => {
  const step = AVATAR_KEYS[ev.key];
  if (step === undefined || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  ev.preventDefault();
  const next = options[step(avatar, options.length)];
  next?.click();
  next?.focus();
});
input.addEventListener("input", () => {
  if (input.ariaInvalid !== "true") return;
  error.textContent = "";
  input.ariaInvalid = "false";
});

// Back in a room this tab was in (reload, restore, return): no Enter form, the stored session rejoins the same member.
// sessionStorage, not localStorage, so a second tab never shares it (ADR 0043). Blocked storage reads as no record.
// The getters themselves throw when storage is blocked: go through them lazily, session-record.ts catches it.
const session = { getItem: (k: string) => sessionStorage.getItem(k), setItem: (k: string, value: string) => { sessionStorage.setItem(k, value); }, removeItem: (k: string) => { sessionStorage.removeItem(k); } };
const local = { getItem: (k: string) => localStorage.getItem(k), setItem: (k: string, value: string) => { localStorage.setItem(k, value); }, removeItem: (k: string) => { localStorage.removeItem(k); } };
// A tab closed within the grace window handed its session on: reopening the link takes the member back (OME-2075).
// Taken on every boot of the room, so it never outlives the next visit.
const handedOff = pathRoom === null ? null : takeHandOff(local, pathRoom, Date.now());
const resumed = pathRoom === null ? null : (loadResume(session, pathRoom) ?? handedOff);
// Just left a room with its Leave key: the landing offers Rejoin for a few seconds (OME-2105). Taken on every boot.
const left = takeLeft(session, Date.now());
// Just created this room from the home page: in with the saved profile, no second entry form (OME-2075).
const creating = pathRoom !== null && resumed === null && takePendingEnter(session, pathRoom) && profile.nickname !== null ? profile.nickname : null;
// Desktop: the entry form is the page's one task, so its field starts focused. Not on touch (the keyboard would pop up),
// and before the intent listeners below, so arriving is not intent (OME-1280).
if (resumed === null && creating === null && (pathRoom !== null || profile.nickname === null) && matchMedia("(pointer: fine)").matches) input.focus();

// Warm the room chunk once the user shows intent, without competing with first paint. On a room link that is anything in
// the entry form (the room is the only way on). On the home page only Enter lobby is: a nickname typed on the way to the
// directory must not fetch the renderer (OME-934 compatibility contract).
let roomModule: Promise<typeof RoomModule> | null = null;
const loadRoom = (): Promise<typeof RoomModule> => (roomModule ??= import("./room"));
const intent: HTMLElement = pathRoom === null ? enter : form;
for (const type of ["focusin", "pointerover", "input"]) intent.addEventListener(type, () => void loadRoom(), { once: true });
// A room link has no other way on, so it fetches the room at the first idle moment, while the nickname is typed (OME-2073).
// Not on `/`: the landing budget counts anything fetched before interaction.
if (pathRoom !== null) {
  if ("requestIdleCallback" in window) requestIdleCallback(() => void loadRoom());
  else setTimeout(() => void loadRoom());
}

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
  const label = enter.textContent;
  enter.disabled = true;
  enter.textContent = "Opening the room…";
  void loadRoom()
    .then(({ startRoom }) => {
      show("room");
      return startRoom({
        root: roomRoot,
        roomId,
        socketUrl: wsUrl(serverUrl, roomId),
        nickname,
        avatar: as,
        avatarAuto: avatarAuto && resumeToken === undefined,
        tint,
        accessory,
        hair,
        ...(resumeToken === undefined ? {} : { resumeToken }),
        secret: secretFor(loadRoomSecrets(storage), roomId, invited),
        secrets: storage,
        origin: location.origin,
        serverUrl,
        extension,
      });
    })
    .then((room) => {
      debug.room = room;
    })
    .catch((e: unknown) => {
      console.error(e);
      show("entry");
      enter.disabled = false;
      enter.textContent = label;
      error.textContent = "Could not open the room. Try again.";
    });
};

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const nickname = checkedNickname();
  if (nickname === null) return;
  saveProfile(localStorage, avatarAuto ? { nickname } : { nickname, avatar });
  enterRoom(nickname, avatar);
});
// index.html ships the button disabled: a click before this handler would submit natively, blocked by CSP form-action (OME-1473).
enter.disabled = false;

if (resumed !== null) {
  // Straight back in: no entry form while the room loads.
  document.documentElement.dataset["view"] = "room";
  welcome.hidden = true;
  form.hidden = true;
  input.value = resumed.nickname;
  selectAvatar(resumed.avatar);
  enterRoom(resumed.nickname, resumed.avatar, resumed.token);
} else if (creating !== null) {
  document.documentElement.dataset["view"] = "room";
  welcome.hidden = true;
  form.hidden = true;
  input.value = creating;
  enterRoom(creating, avatar);
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
        share: shareLink,
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
    saveProfile(localStorage, avatarAuto ? { nickname } : { nickname, avatar });
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
    show("entry");
    for (const target of [form, findRoom]) {
      for (const type of ["focusin", "pointerover", "input"]) target.addEventListener(type, mountHome, { once: true });
    }
  }
} else if (resumed === null && creating === null) show("entry");
if (pathRoom === null && left !== null) {
  mountRejoinChip({ parent: document.body, left, now: Date.now(), session, navigate: (path) => { location.assign(path); }, setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (id) => { window.clearTimeout(id); } });
}

performance.mark("omega:interactive");
