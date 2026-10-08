import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ROOM_SECRETS_STORAGE_KEY, type RoomSummary } from "@omega/shared";
import type { HomeOptions } from "../src/home";
import { loadRoomSecrets, rememberRoom } from "../src/room-secrets";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

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
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

let store: MemoryStore;
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
    expect(JSON.parse(typeof post?.init?.body === "string" ? post.init.body : "null")).toEqual({ title: "Movie night", visibility: "private" });
    expect(loadRoomSecrets(store).rooms[ROOM]).toEqual({ ownerToken: OWNER, inviteKey: KEY });
    expect(navigated).toEqual([`/r/${ROOM}`]);
  });

  test("a public room is posted as public and saves only the owner token", async () => {
    created = { status: 201, body: { ok: true, room: { id: ROOM, title: "Open house", visibility: "public" }, ownerToken: OWNER } };
    const root = await mount();
    await submit(root, "Open house", false);
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(typeof post?.init?.body === "string" ? post.init.body : "null")).toEqual({ title: "Open house", visibility: "public" });
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
    const { ready } = mountHome({ root, serverUrl: SERVER, store, fetch: () => pending, navigate: (path) => navigated.push(path) });
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
