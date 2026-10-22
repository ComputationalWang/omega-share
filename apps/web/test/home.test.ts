import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ROOM_SECRETS_STORAGE_KEY, type RoomSummary } from "@omega/shared";
import { cinema, classic } from "./support/preset-layouts";
import type { HomeOptions } from "../src/home";
import { PRESETS } from "../src/presets";
import { pendingLayoutKey, pendingShareKey } from "../src/pending-layout";
import { SAVED_LAYOUTS_KEY, loadSavedLayouts, saveLayout } from "../src/saved-layouts";
import { loadRoomSecrets, rememberRoom } from "../src/room-secrets";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const THUMBS = { classic: "/t/classic.png", cinema: "/t/cinema.png", living: "/t/living.png", lounge: "/t/lounge.png", cafe: "/t/cafe.png", bar: "/t/bar.png", empty: "/t/empty.png", "dank-dungeon": "/t/dank-dungeon.png" };
const SERVER = "http://api.test";
const ROOM = "abcdefghijklmnopqrstuvwxyz";
const OWNER = "o".repeat(21) + "A";
const KEY = "k".repeat(21) + "_";

class MemoryStore {
  readonly data = new Map<string, string>();
  failWrites = false;
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.data.set(k, value);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

let store: MemoryStore;
let session: MemoryStore;
let calls: Call[];
let navigated: string[];
let listed: RoomSummary[] | string;
let created: { status: number; body: unknown };
/** The raw `#share=` value main.ts took at boot (OME-1085). */
let share: string | null;
/** When set, GET /rooms answers through this instead of `listed` (a pending, failing or later answer). */
let listing: (() => Promise<Response>) | null;
/** When set, POST /rooms answers through this (e.g. held open to see the submitting state). */
let holdPost: (() => Promise<Response>) | null;

const json = (status: number, body: unknown): Response => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function mount(): Promise<HTMLElement> {
  const { root, ready } = await mountOnly();
  await ready;
  return root;
}

async function mountOnly(): Promise<{ root: HTMLElement; ready: Promise<void> }> {
  const { mountHome } = await import("../src/home");
  const root = document.createElement("section");
  document.body.replaceChildren(root);
  const opts: HomeOptions = {
    root,
    serverUrl: SERVER,
    store,
    session,
    thumbs: THUMBS,
    fetch: (url, init) => {
      calls.push({ url, init });
      if (init?.method === "POST") return holdPost === null ? Promise.resolve(json(created.status, created.body)) : holdPost();
      if (listing !== null) return listing();
      return Promise.resolve(json(200, typeof listed === "string" ? listed : { rooms: listed }));
    },
    navigate: (path) => navigated.push(path),
    share,
  };
  return { root, ready: mountHome(opts).ready };
}

const byTestId = <T extends Element>(root: ParentNode, id: string, type: new () => T): T => {
  const e = root.querySelector(`[data-testid=${id}]`);
  if (!(e instanceof type)) throw new Error(`missing ${id}`);
  return e;
};
const all = (root: ParentNode, id: string): Element[] => [...root.querySelectorAll(`[data-testid=${id}]`)];
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function submit(root: HTMLElement, title: string, priv: boolean): Promise<void> {
  byTestId(root, "create-room-title", HTMLInputElement).value = title;
  byTestId(root, "create-room-private", HTMLInputElement).checked = priv;
  byTestId(root, "create-room-form", HTMLFormElement).requestSubmit();
  for (let i = 0; i < 5; i++) await settle();
}

beforeEach(() => {
  store = new MemoryStore();
  session = new MemoryStore();
  calls = [];
  navigated = [];
  listed = [];
  listing = null;
  holdPost = null;
  share = null;
  created = { status: 201, body: { ok: true, room: { id: ROOM, title: "Movie night", visibility: "private" }, ownerToken: OWNER, inviteKey: KEY } };
});

describe("create room (POST /rooms)", () => {
  test("posts the title and visibility, saves the owner token and invite key, then opens /r/<id> with no secret in it", async () => {
    const root = await mount();
    await submit(root, "  Movie night ", true);
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe(`${SERVER}/rooms`);
    expect(new Headers(post?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(typeof post?.init?.body === "string" ? post.init.body : "null")).toEqual({ title: "Movie night", visibility: "private", preset: "classic" });
    expect(loadRoomSecrets(store).rooms[ROOM]).toEqual({ ownerToken: OWNER, inviteKey: KEY, title: "Movie night" });
    expect(navigated).toEqual([`/r/${ROOM}`]);
  });

  test("a public room is posted as public and saves the owner token and title, no invite key", async () => {
    created = { status: 201, body: { ok: true, room: { id: ROOM, title: "Open house", visibility: "public" }, ownerToken: OWNER } };
    const root = await mount();
    await submit(root, "Open house", false);
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(typeof post?.init?.body === "string" ? post.init.body : "null")).toEqual({ title: "Open house", visibility: "public", preset: "classic" });
    expect(loadRoomSecrets(store).rooms[ROOM]).toEqual({ ownerToken: OWNER, title: "Open house" });
  });

  test("an invalid title is refused on the page: nothing is posted", async () => {
    const root = await mount();
    for (const title of ["", "   ", "<b>x</b>", "x".repeat(33)]) {
      await submit(root, title, false);
      expect(byTestId(root, "create-room-error", HTMLElement).textContent).not.toBe("");
    }
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(0);
    expect(navigated).toEqual([]);
  });

  test("rate_limited: says when to try again, saves nothing and stays on the page", async () => {
    created = { status: 429, body: { ok: false, error: { code: "rate_limited", message: "slow", retryAfterMs: 300_000 } } };
    const root = await mount();
    await submit(root, "Movie night", true);
    expect(byTestId(root, "create-room-error", HTMLElement).textContent).toContain("5 min");
    expect(store.getItem(ROOM_SECRETS_STORAGE_KEY)).toBeNull();
    expect(navigated).toEqual([]);
    expect(byTestId(root, "create-room-submit", HTMLButtonElement).disabled).toBe(false);
  });

  test("too_many_rooms and an unparseable answer both show an error, never a throw", async () => {
    for (const body of [{ ok: false, error: { code: "too_many_rooms", message: "full" } }, "not json", { ok: true, room: { id: ROOM }, ownerToken: "short" }]) {
      created = { status: 503, body };
      const root = await mount();
      await submit(root, "Movie night", false);
      expect(byTestId(root, "create-room-error", HTMLElement).textContent).not.toBe("");
      expect(navigated).toEqual([]);
    }
  });
});

describe("a link shared from the extension (#share=, OME-1085)", () => {
  const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  test("the create form says the video will play in the new room, as text, and creating stashes it for the room page", async () => {
    share = YT;
    const root = await mount();
    const note = byTestId(root, "share-pending", HTMLElement);
    expect(note.textContent).toContain("This video will play in your new room");
    expect(note.textContent).toContain(YT);
    expect(root.querySelector("iframe")).toBeNull();
    await submit(root, "Movie night", false);
    expect(session.data.get(pendingShareKey(ROOM))).toBe(YT);
    expect(navigated).toEqual([`/r/${ROOM}`]);
  });

  test("Discard removes it: no note, nothing stashed", async () => {
    share = YT;
    const root = await mount();
    byTestId(root, "share-discard", HTMLButtonElement).click();
    expect(all(root, "share-pending")).toEqual([]);
    await submit(root, "Movie night", false);
    expect(session.data.has(pendingShareKey(ROOM))).toBe(false);
  });

  test("an unplayable link is dropped silently: no note, nothing stashed", async () => {
    for (const bad of ["javascript:alert(1)", "<img src=x onerror=alert(1)>", "http://insecure.example/v"]) {
      share = bad;
      const root = await mount();
      expect(all(root, "share-pending")).toEqual([]);
      expect(root.querySelector("iframe, img[src=x]")).toBeNull();
    }
    expect(session.data.size).toBe(0);
  });
});

describe("create room when storage is blocked", () => {
  test("the room's secrets can't be saved: stays on the page and says why instead of opening an unmanageable room", async () => {
    store.failWrites = true;
    const root = await mount();
    await submit(root, "Movie night", true);
    expect(navigated).toEqual([]);
    expect(byTestId(root, "create-room-error", HTMLElement).textContent).toContain("storage");
  });
});

describe("public rooms (GET /rooms)", () => {
  test("lists each room as a link to /r/<id>, its title as text only", async () => {
    listed = [
      { id: "lobby", memberCount: 3, seatedCount: 1, title: "Lobby" },
      { id: ROOM, memberCount: 0, seatedCount: 0 },
    ];
    const root = await mount();
    const links = all(root, "public-room-link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/r/lobby", `/r/${ROOM}`]);
    expect(links[0]?.textContent).toBe("Lobby");
    // No title (an older server): the id stands in.
    expect(links[1]?.textContent).toBe(ROOM);
    for (const a of links) expect(a.children).toHaveLength(0);
    expect(calls[0]?.url).toBe(`${SERVER}/rooms`);
  });

  test("a malformed list shows no rooms and says the server couldn't be reached, instead of throwing", async () => {
    listed = "{";
    const root = await mount();
    expect(all(root, "public-room-link")).toHaveLength(0);
    expect(byTestId(root, "public-rooms-status", HTMLElement).textContent).toBe("Could not reach the server. Try again.");
  });
});

describe("open rooms: loading, empty and error are told apart (OME-935)", () => {
  const status = (root: ParentNode): string => byTestId(root, "public-rooms-status", HTMLElement).textContent;
  const list = (root: ParentNode): HTMLElement => byTestId(root, "public-rooms", HTMLElement);

  test("while the list loads it is busy and says so, and saved rooms are already there", async () => {
    rememberRoom(store, ROOM, { inviteKey: KEY });
    let answer: (r: Response) => void = () => undefined;
    listing = () => new Promise((r) => (answer = r));
    const { root, ready } = await mountOnly();
    expect(list(root).getAttribute("aria-busy")).toBe("true");
    expect(status(root)).toBe("Finding rooms…");
    expect(all(root, "your-room-link")).toHaveLength(1);
    answer(json(200, { rooms: [{ id: "lobby", memberCount: 2, seatedCount: 0, title: "Lobby" }] }));
    await ready;
    expect(list(root).getAttribute("aria-busy")).toBe("false");
    expect(status(root)).toBe("");
    expect(all(root, "public-room-link")).toHaveLength(1);
  });

  test("only a successful empty answer says there are no public rooms", async () => {
    listed = [];
    const root = await mount();
    expect(status(root)).toBe("No public rooms right now.");
    expect(root.querySelector("[data-testid=public-rooms-retry]")).toBeNull();
  });

  test("a network failure says so with a real Retry button; saved rooms stay; Retry loads the list", async () => {
    rememberRoom(store, ROOM, { ownerToken: OWNER });
    listing = () => Promise.reject(new Error("offline"));
    const root = await mount();
    expect(status(root)).toBe("Could not reach the server. Try again.");
    expect(status(root)).not.toContain("No public rooms");
    expect(all(root, "your-room-link")).toHaveLength(1);
    const retry = byTestId(root, "public-rooms-retry", HTMLButtonElement);
    expect(retry.type).toBe("button");
    listing = null;
    listed = [{ id: ROOM, memberCount: 4, seatedCount: 0, title: "Movie night" }];
    retry.click();
    for (let i = 0; i < 5; i++) await settle();
    expect(all(root, "public-room-link").map((a) => a.textContent)).toEqual(["Movie night"]);
    expect(root.querySelector("[data-testid=public-rooms-retry]")).toBeNull();
    // The saved room picks up its title and head count from the list.
    expect(all(root, "your-room-link").map((a) => a.textContent)).toEqual(["Movie night"]);
    expect(byTestId(root, "your-room", HTMLElement).textContent).toContain("4 here");
  });

  test("the Open rooms heading is a focus target for the page's quick link", async () => {
    const root = await mount();
    const h = root.querySelector("#open-rooms");
    expect(h?.tagName).toBe("H2");
    expect(h?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("your rooms: an honest empty state and plain labels (OME-935)", () => {
  test("a private room reads by its saved title, as text; the public title wins when listed; no title falls back to the id (OME-1284)", async () => {
    rememberRoom(store, ROOM, { ownerToken: OWNER, inviteKey: KEY, title: "Film night" });
    let root = await mount();
    const link = byTestId(root, "your-room-link", HTMLAnchorElement);
    expect(link.textContent).toBe("Film night");
    expect(link.children).toHaveLength(0);
    listed = [{ id: ROOM, memberCount: 1, seatedCount: 0, title: "Open house" }];
    root = await mount();
    expect(byTestId(root, "your-room-link", HTMLAnchorElement).textContent).toBe("Open house");
    store.data.clear();
    rememberRoom(store, ROOM, { inviteKey: KEY });
    listed = [];
    root = await mount();
    expect(byTestId(root, "your-room-link", HTMLAnchorElement).textContent).toBe(ROOM);
  });

  test("no saved rooms says so instead of hiding the section", async () => {
    const root = await mount();
    expect(byTestId(root, "your-rooms-empty", HTMLElement).textContent).toBe("No saved rooms in this browser yet.");
  });

  test("a saved room says private or public and owner or invited, never a secret", async () => {
    rememberRoom(store, ROOM, { ownerToken: OWNER, inviteKey: KEY });
    const root = await mount();
    const row = byTestId(root, "your-room", HTMLElement).textContent;
    expect(row).toContain("Private");
    expect(row).toContain("owner");
    expect(row).not.toContain(OWNER);
    expect(row).not.toContain(KEY);
    expect(root.querySelector("[data-testid=your-rooms-empty]")).toBeNull();
  });
});

describe("create room: the submitting state (OME-935)", () => {
  test("while posting, the button is disabled and says Creating room…; a failure restores it, keeps the title and focuses it", async () => {
    let answer: (r: Response) => void = () => undefined;
    const root = await mount();
    const button = byTestId(root, "create-room-submit", HTMLButtonElement);
    const title = byTestId(root, "create-room-title", HTMLInputElement);
    const pending = new Promise<Response>((r) => (answer = r));
    holdPost = () => pending;
    title.value = "Movie night";
    byTestId(root, "create-room-form", HTMLFormElement).requestSubmit();
    await settle();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Creating room…");
    answer(json(503, { ok: false, error: { code: "unavailable", message: "x" } }));
    for (let i = 0; i < 5; i++) await settle();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Create room");
    expect(title.value).toBe("Movie night");
    expect(document.activeElement).toBe(title);
    expect(byTestId(root, "create-room-error", HTMLElement).textContent).not.toBe("");
  });
});

describe("your rooms (localStorage omega.rooms)", () => {
  test("lists every stored room, newest first, with its public title when it has one", async () => {
    rememberRoom(store, "lobby", { inviteKey: KEY });
    rememberRoom(store, ROOM, { ownerToken: OWNER });
    listed = [{ id: ROOM, memberCount: 0, seatedCount: 0, title: "Movie night" }];
    const root = await mount();
    const links = all(root, "your-room-link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([`/r/${ROOM}`, "/r/lobby"]);
    expect(links[0]?.textContent).toBe("Movie night");
    expect(all(root, "your-room").map((li) => li.getAttribute("data-owner"))).toEqual(["true", "false"]);
  });

  test("forget removes an invited room from storage and from the list", async () => {
    rememberRoom(store, ROOM, { inviteKey: KEY });
    const root = await mount();
    byTestId(root, "your-room-forget", HTMLButtonElement).click();
    expect(loadRoomSecrets(store).rooms).toEqual({});
    expect(all(root, "your-room")).toHaveLength(0);
  });

  test("forgetting a room you own takes a second click: the owner token can't be recovered", async () => {
    rememberRoom(store, ROOM, { ownerToken: OWNER });
    const root = await mount();
    const forget = byTestId(root, "your-room-forget", HTMLButtonElement);
    forget.click();
    expect(loadRoomSecrets(store).rooms[ROOM]).toEqual({ ownerToken: OWNER });
    expect(forget.textContent).toContain("can't undo");
    byTestId(root, "your-room-forget", HTMLButtonElement).click();
    expect(loadRoomSecrets(store).rooms).toEqual({});
  });

  test("a first forget click made before the room list loads stays armed when the list arrives (OME-458)", async () => {
    rememberRoom(store, ROOM, { ownerToken: OWNER });
    const { mountHome } = await import("../src/home");
    const root = document.createElement("section");
    document.body.replaceChildren(root);
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((r) => {
      release = r;
    });
    const { ready } = mountHome({ root, serverUrl: SERVER, store, session, thumbs: THUMBS, fetch: () => pending, navigate: (path) => navigated.push(path), share: null });
    byTestId(root, "your-room-forget", HTMLButtonElement).click();
    release(json(200, { rooms: [] }));
    await ready;
    expect(byTestId(root, "your-room-forget", HTMLButtonElement).textContent).toContain("can't undo");
    byTestId(root, "your-room-forget", HTMLButtonElement).click();
    expect(loadRoomSecrets(store).rooms).toEqual({});
  });

  test("the list never shows an owner token or invite key", async () => {
    rememberRoom(store, ROOM, { ownerToken: OWNER, inviteKey: KEY });
    const root = await mount();
    expect(root.textContent).not.toContain(OWNER);
    expect(root.innerHTML).not.toContain(OWNER);
    expect(root.innerHTML).not.toContain(KEY);
  });
});

const postedBody = (): unknown => {
  const post = calls.find((c) => c.init?.method === "POST");
  return JSON.parse(typeof post?.init?.body === "string" ? post.init.body : "null");
};
const radios = (root: ParentNode): HTMLInputElement[] => [...root.querySelectorAll("input[type=radio][name=preset]")].filter((e): e is HTMLInputElement => e instanceof HTMLInputElement);
const radio = (root: ParentNode, id: string): HTMLInputElement => byTestId(root, `preset-${id}`, HTMLInputElement);

describe("room presets in the create form (OME-910)", () => {
  test("a fieldset with a legend holds one native radio per preset, classic checked by default", async () => {
    const root = await mount();
    const fieldset = byTestId(root, "preset-picker", HTMLFieldSetElement);
    expect(fieldset.querySelector("legend")?.textContent).not.toBe("");
    const presets = [...fieldset.querySelectorAll("input[type=radio]")].filter((e): e is HTMLInputElement => e instanceof HTMLInputElement);
    expect(presets.map((r) => r.value)).toEqual(PRESETS.map((p) => p.id));
    expect(new Set(presets.map((r) => r.name))).toEqual(new Set(["preset"]));
    expect(presets.filter((r) => r.checked).map((r) => r.value)).toEqual(["classic"]);
  });

  // OME-1022: eager, not lazy. The home chunk mounts on intent while the directory is still hidden, so a lazy thumbnail
  // would only start loading once the directory shows (pop-in).
  test("each radio's label holds an eager fixed-size thumbnail with empty alt, the name and the blurb", async () => {
    const root = await mount();
    for (const p of PRESETS) {
      const label = radio(root, p.id).closest("label");
      const img = label?.querySelector("img");
      expect(img?.getAttribute("loading")).toBeNull();
      expect(img?.getAttribute("decoding")).toBe("async");
      expect(img?.getAttribute("alt")).toBe("");
      expect(img?.getAttribute("width")).toBe("212");
      expect(img?.getAttribute("height")).toBe("176");
      expect(img?.getAttribute("src")).toBe(`/t/${p.id}.png`);
      expect(label?.textContent).toContain(p.name);
      expect(label?.textContent).toContain(p.blurb);
    }
  });

  test("the default sends preset classic; a picked preset is sent as is", async () => {
    let root = await mount();
    await submit(root, "Movie night", false);
    expect(postedBody()).toEqual({ title: "Movie night", visibility: "public", preset: "classic" });
    calls = [];
    root = await mount();
    radio(root, "cinema").click();
    await submit(root, "Movie night", false);
    expect(postedBody()).toEqual({ title: "Movie night", visibility: "public", preset: "cinema" });
    expect(session.data.size).toBe(0);
  });
});

describe("your saved layouts in the create form (OME-910)", () => {
  test("no saved layouts: no second group", async () => {
    const root = await mount();
    expect(root.querySelector("[data-testid=saved-layouts]")).toBeNull();
  });

  test("each saved layout is a text-only radio in the same choice; picking one posts empty and stashes the layout for the room page", async () => {
    saveLayout(store, "Mine", cinema);
    saveLayout(store, "<b>Other</b>", classic);
    const root = await mount();
    const group = byTestId(root, "saved-layouts", HTMLFieldSetElement);
    expect(group.querySelector("img")).toBeNull();
    const saved = all(group, "saved-layout").map((e) => e.textContent);
    expect(saved.join("|")).toContain("Mine");
    expect(saved.join("|")).toContain("<b>Other</b>");
    expect(group.querySelector("b")).toBeNull();
    const mine = byTestId(group, "saved-layout-radio", HTMLInputElement);
    mine.click();
    expect(radio(root, "classic").checked).toBe(false);
    await submit(root, "Movie night", false);
    expect(postedBody()).toEqual({ title: "Movie night", visibility: "public", preset: "empty" });
    expect(JSON.parse(session.data.get(pendingLayoutKey(ROOM)) ?? "null")).toEqual(cinema);
    expect(navigated).toEqual([`/r/${ROOM}`]);
  });

  test("the stash is written after the 201 and not at all when the create fails", async () => {
    saveLayout(store, "Mine", cinema);
    created = { status: 503, body: { ok: false, error: { code: "unavailable", message: "x" } } };
    const root = await mount();
    byTestId(root, "saved-layout-radio", HTMLInputElement).click();
    await submit(root, "Movie night", false);
    expect(session.data.size).toBe(0);
    expect(navigated).toEqual([]);
  });

  test("delete removes it from storage and the list and falls back to the default preset", async () => {
    saveLayout(store, "Mine", cinema);
    const root = await mount();
    byTestId(root, "saved-layout-radio", HTMLInputElement).click();
    byTestId(root, "saved-layout-delete", HTMLButtonElement).click();
    expect(loadSavedLayouts(store)).toEqual([]);
    expect(root.querySelector("[data-testid=saved-layout]")).toBeNull();
    expect(radios(root).filter((r) => r.checked).map((r) => r.value)).toEqual(["classic"]);
  });

  test("garbage in the saved-layouts key: the form still renders and creates a room", async () => {
    for (const raw of ["not json{", JSON.stringify([{ name: "x", layout: { furniture: [] } }])]) {
      store.data.set(SAVED_LAYOUTS_KEY, raw);
      calls = [];
      const root = await mount();
      expect(radios(root)).toHaveLength(PRESETS.length);
      expect(root.querySelector("[data-testid=saved-layouts]")).toBeNull();
      await submit(root, "Movie night", false);
      expect(postedBody()).toEqual({ title: "Movie night", visibility: "public", preset: "classic" });
    }
  });
});
