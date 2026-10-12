import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ROOM_SECRETS_STORAGE_KEY, type RoomSummary } from "@omega/shared";
import { cinema, classic } from "./support/preset-layouts";
import type { HomeOptions } from "../src/home";
import { PRESETS } from "../src/presets";
import { pendingLayoutKey } from "../src/pending-layout";
import { SAVED_LAYOUTS_KEY, loadSavedLayouts, saveLayout } from "../src/saved-layouts";
import { loadRoomSecrets, rememberRoom } from "../src/room-secrets";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const THUMBS = { classic: "/t/classic.png", cinema: "/t/cinema.png", living: "/t/living.png", lounge: "/t/lounge.png", cafe: "/t/cafe.png", empty: "/t/empty.png" };
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

const json = (status: number, body: unknown): Response => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function mount(): Promise<HTMLElement> {
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
      if (init?.method === "POST") return Promise.resolve(json(created.status, created.body));
      return Promise.resolve(json(200, typeof listed === "string" ? listed : { rooms: listed }));
    },
    navigate: (path) => navigated.push(path),
  };
  await mountHome(opts).ready;
  return root;
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
    expect(loadRoomSecrets(store).rooms[ROOM]).toEqual({ ownerToken: OWNER, inviteKey: KEY });
    expect(navigated).toEqual([`/r/${ROOM}`]);
  });

  test("a public room is posted as public and saves only the owner token", async () => {
    created = { status: 201, body: { ok: true, room: { id: ROOM, title: "Open house", visibility: "public" }, ownerToken: OWNER } };
    const root = await mount();
    await submit(root, "Open house", false);
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(typeof post?.init?.body === "string" ? post.init.body : "null")).toEqual({ title: "Open house", visibility: "public", preset: "classic" });
    expect(loadRoomSecrets(store).rooms[ROOM]).toEqual({ ownerToken: OWNER });
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

  test("a malformed list shows no rooms instead of throwing", async () => {
    listed = "{";
    const root = await mount();
    expect(all(root, "public-room-link")).toHaveLength(0);
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
    const { ready } = mountHome({ root, serverUrl: SERVER, store, session, thumbs: THUMBS, fetch: () => pending, navigate: (path) => navigated.push(path) });
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

  test("each radio's label holds a lazy fixed-size thumbnail with empty alt, the name and the blurb", async () => {
    const root = await mount();
    for (const p of PRESETS) {
      const label = radio(root, p.id).closest("label");
      const img = label?.querySelector("img");
      expect(img?.getAttribute("loading")).toBe("lazy");
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
