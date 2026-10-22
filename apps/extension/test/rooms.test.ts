import { describe, expect, mock, test } from "bun:test";
import { NEW_ROOM, loadRooms, newRoomUrl, roomUrl, watchingBadge, withLastRoom, withNewRoom, withRoomTabs, withWatching } from "../src/rooms";

const BASE = "http://localhost:8787";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const FALLBACK = { rooms: [{ id: "lobby", label: "lobby" }], selected: "lobby" };
/** What `fetch(…, { redirect: "manual" })` yields for a redirect: an opaque response with status 0. */
const opaqueRedirect = (): Response => {
  const r = new Response(null, { status: 200 });
  Object.defineProperty(r, "type", { value: "opaqueredirect" });
  Object.defineProperty(r, "status", { value: 0 });
  Object.defineProperty(r, "ok", { value: false });
  return r;
};

describe("loadRooms", () => {
  test("GETs /rooms once and labels each room with its member count, lobby selected", async () => {
    const fetch = mock<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        json({
          rooms: [
            { id: "movies", memberCount: 7, seatedCount: 2 },
            { id: "lobby", memberCount: 3, seatedCount: 1 },
          ],
        }),
      ),
    );
    expect(await loadRooms({ baseUrl: BASE, fetch })).toEqual({
      kind: "ok",
      list: {
        rooms: [
          { id: "movies", label: "movies (7)", watching: 7 },
          { id: "lobby", label: "lobby (3)", watching: 3 },
        ],
        selected: "lobby",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/rooms`);
    expect(init?.method).toBe("GET");
  });

  test("a titled room is labelled with its title (ADR 0028); an untitled one keeps its id", async () => {
    const fetch = mock(() =>
      Promise.resolve(
        json({
          rooms: [
            { id: "lobby", memberCount: 3, seatedCount: 1 },
            { id: "abcdefghijklmnopqrstuvwxyz", memberCount: 7, seatedCount: 2, title: "Movie night" },
          ],
        }),
      ),
    );
    expect(await loadRooms({ baseUrl: BASE, fetch })).toEqual({
      kind: "ok",
      list: {
        rooms: [
          { id: "lobby", label: "lobby (3)", watching: 3 },
          { id: "abcdefghijklmnopqrstuvwxyz", label: "Movie night (7)", title: "Movie night", watching: 7 },
        ],
        selected: "lobby",
      },
    });
  });

  test("sends the tunnel headers: skips ngrok's browser warning, carries edge cookies, never follows a redirect", async () => {
    const fetch = mock<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(json({ rooms: [] })));
    await loadRooms({ baseUrl: BASE, fetch });
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("ngrok-skip-browser-warning")).toBe("1");
    expect(init?.credentials).toBe("include");
    expect(init?.redirect).toBe("manual");
  });

  test("selects the first room when lobby is not listed", async () => {
    const fetch = mock(() => Promise.resolve(json({ rooms: [{ id: "movies", memberCount: 0, seatedCount: 0 }] })));
    expect(await loadRooms({ baseUrl: BASE, fetch })).toEqual({
      kind: "ok",
      list: { rooms: [{ id: "movies", label: "movies (0)", watching: 0 }], selected: "movies" },
    });
  });

  test("an empty list is still a working server: the lobby alone", async () => {
    expect(await loadRooms({ baseUrl: BASE, fetch: mock(() => Promise.resolve(json({ rooms: [] }))) })).toEqual({ kind: "ok", list: FALLBACK });
  });

  const outcomes: readonly { name: string; response: () => Promise<Response>; kind: "unreachable" | "offline" | "sign-in" }[] = [
    { name: "a network error (DNS, TLS, refused)", response: () => Promise.reject(new TypeError("Failed to fetch")), kind: "unreachable" },
    { name: "a non-2xx plain-text body", response: () => Promise.resolve(new Response("Forbidden origin", { status: 403 })), kind: "offline" },
    { name: "a non-2xx JSON body on the contract", response: () => Promise.resolve(json({ rooms: [{ id: "x", memberCount: 1, seatedCount: 0 }] }, 500)), kind: "offline" },
    { name: "ngrok's HTML offline page", response: () => Promise.resolve(new Response("<!doctype html><title>ERR_NGROK_3200</title>", { status: 404, headers: { "content-type": "text/html" } })), kind: "offline" },
    { name: "an HTML 200 (interstitial)", response: () => Promise.resolve(new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })), kind: "offline" },
    { name: "bad JSON", response: () => Promise.resolve(new Response("{not json", { status: 200 })), kind: "offline" },
    { name: "a schema failure", response: () => Promise.resolve(json({ rooms: [{ id: "../admin", memberCount: 1, seatedCount: 0 }] })), kind: "offline" },
    { name: "a 401 from an edge gate", response: () => Promise.resolve(new Response("Unauthorized", { status: 401 })), kind: "sign-in" },
    { name: "a redirect to an OAuth login", response: () => Promise.resolve(opaqueRedirect()), kind: "sign-in" },
  ];
  for (const o of outcomes) {
    test(`${o.name} → ${o.kind}`, async () => {
      expect(await loadRooms({ baseUrl: BASE, fetch: mock(o.response) })).toEqual({ kind: o.kind });
    });
  }
});

describe("withRoomTabs: the dropdown is the open room tabs first, then the listed rooms (threat model §3.5)", () => {
  const PRIVATE = "abcdefghijklmnopqrstuvwxyz";
  const listed = {
    rooms: [
      { id: "lobby", label: "lobby (3)" },
      { id: "movies", label: "Movie night (7)" },
    ],
    selected: "lobby",
  };
  const T = "AAAAAAAAAAAAAAAAAAAAAA";

  test("no open room tabs: the listed rooms unchanged", () => {
    expect(withRoomTabs(listed, { rooms: [], tokens: new Map() })).toEqual(listed);
  });

  test("a private room open in a tab is added (by id) and selected when it holds a token", () => {
    expect(withRoomTabs(listed, { rooms: [PRIVATE], tokens: new Map([[PRIVATE, T]]) })).toEqual({
      rooms: [
        { id: PRIVATE, label: PRIVATE },
        { id: "lobby", label: "lobby (3)" },
        { id: "movies", label: "Movie night (7)" },
      ],
      selected: PRIVATE,
    });
  });

  test("a listed room open in a tab moves first and keeps its title label, never listed twice", () => {
    expect(withRoomTabs(listed, { rooms: ["movies"], tokens: new Map() })).toEqual({
      rooms: [
        { id: "movies", label: "Movie night (7)" },
        { id: "lobby", label: "lobby (3)" },
      ],
      selected: "movies",
    });
  });

  test("the first tab room holding a token is selected over earlier tabs without one", () => {
    expect(withRoomTabs(listed, { rooms: [PRIVATE, "movies"], tokens: new Map([["movies", T]]) }).selected).toBe("movies");
  });

  test("the server unreachable: the tab rooms still come first, the lobby fallback after", () => {
    const fallback = { rooms: [{ id: "lobby", label: "lobby" }], selected: "lobby" };
    expect(withRoomTabs(fallback, { rooms: [PRIVATE], tokens: new Map() })).toEqual({
      rooms: [
        { id: PRIVATE, label: PRIVATE },
        { id: "lobby", label: "lobby" },
      ],
      selected: PRIVATE,
    });
  });
});

describe("withNewRoom: \"New room…\" ends the dropdown, preselected when there's no room to share into (OME-1086)", () => {
  const T = "AAAAAAAAAAAAAAAAAAAAAA";
  const ok = { kind: "ok", list: FALLBACK } as const;
  const list = { rooms: [{ id: "movies", label: "movies" }, ...FALLBACK.rooms], selected: "movies" };
  const NEW = { id: NEW_ROOM, label: "New room…" };

  test("a room holding a share token keeps its selection; New room comes last", () => {
    expect(withNewRoom(list, ok, new Map([["movies", T]]))).toEqual({ rooms: [...list.rooms, NEW], selected: "movies" });
  });

  test("no room holds a share token: New room is selected", () => {
    expect(withNewRoom(list, ok, new Map()).selected).toBe(NEW_ROOM);
  });

  test("a token for a room that isn't in the dropdown doesn't count", () => {
    expect(withNewRoom(list, ok, new Map([["gone", T]])).selected).toBe(NEW_ROOM);
  });

  for (const kind of ["unreachable", "offline", "sign-in"] as const) {
    test(`the probe failed (${kind}): New room is selected even with a token`, () => {
      expect(withNewRoom(list, { kind }, new Map([["movies", T]])).selected).toBe(NEW_ROOM);
    });
  }

  test("the sentinel is no valid room id", () => {
    expect(NEW_ROOM).toBe("");
  });
});

describe("newRoomUrl: the ADR 0049 hand-off link", () => {
  test("the site's home with the video in a #share= fragment, percent-encoded", () => {
    expect(newRoomUrl("https://omega.example", "https://www.youtube.com/embed/aqz-KE-bpKQ?start=5&t=1")).toBe(
      "https://omega.example/#share=https%3A%2F%2Fwww.youtube.com%2Fembed%2Faqz-KE-bpKQ%3Fstart%3D5%26t%3D1",
    );
  });

  test("a local origin with a port", () => {
    expect(newRoomUrl("http://localhost:8787", "https://player.vimeo.com/video/76979871")).toBe("http://localhost:8787/#share=https%3A%2F%2Fplayer.vimeo.com%2Fvideo%2F76979871");
  });
});

describe("roomUrl: the success line's link to the room (OME-1287)", () => {
  test("the site's /r/<id> on the parsed origin", () => {
    expect(roomUrl("https://omega.example", "movies")).toBe("https://omega.example/r/movies");
    expect(roomUrl("http://localhost:8787", "lobby")).toBe("http://localhost:8787/r/lobby");
  });

  test("the id is percent-encoded, so it can't leave the path", () => {
    expect(roomUrl("https://omega.example", "a/../b?c#d")).toBe("https://omega.example/r/a%2F..%2Fb%3Fc%23d");
  });
});

describe("withLastRoom: the room shared into last is preselected while it's listed and holds a share token (OME-1287)", () => {
  const LIST = { rooms: [{ id: "lobby", label: "lobby (1)" }, { id: "movies", label: "Movies (2)" }], selected: "lobby" };
  const TOKENS = new Map([["lobby", "t1"], ["movies", "t2"]]);

  test("a listed last room with a token is selected", () => {
    expect(withLastRoom(LIST, "movies", TOKENS)).toEqual({ ...LIST, selected: "movies" });
  });

  test("a listed last room without a token is ignored: there's nothing to share into", () => {
    expect(withLastRoom(LIST, "movies", new Map([["lobby", "t1"]]))).toEqual(LIST);
  });

  for (const stored of ["gone", undefined, 42, null, NEW_ROOM]) {
    test(`${String(stored)} is ignored`, () => {
      expect(withLastRoom(LIST, stored, new Map([...TOKENS, ["gone", "t3"]]))).toEqual(LIST);
    });
  }
});

describe("loadRooms: who is watching what (OME-1637, ADR 0056)", () => {
  test("each room carries its watching count (members as a fallback for an older server) and its nowPlaying", async () => {
    const fetch = mock(() =>
      Promise.resolve(
        json({
          rooms: [
            { id: "movies", memberCount: 7, seatedCount: 2, title: "Movie night", watchingCount: 5, nowPlaying: { provider: "youtube", id: "dQw4w9WgXcQ" } },
            { id: "lobby", memberCount: 3, seatedCount: 1 },
          ],
        }),
      ),
    );
    expect(await loadRooms({ baseUrl: BASE, fetch })).toEqual({
      kind: "ok",
      list: {
        rooms: [
          { id: "movies", label: "Movie night (7)", title: "Movie night", watching: 5, nowPlaying: { provider: "youtube", id: "dQw4w9WgXcQ" } },
          { id: "lobby", label: "lobby (3)", watching: 3 },
        ],
        selected: "lobby",
      },
    });
  });
});

describe("withWatching: rooms already playing a video on the page sort first, \"N watching · Join\" (OME-1637)", () => {
  const RICK = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" } as const;
  const LIVE = { provider: "twitch", kind: "live", channel: "somechannel", url: "https://player.twitch.tv/?channel=somechannel" } as const;
  const list = {
    rooms: [
      { id: "lobby", label: "lobby (3)", watching: 3 },
      { id: "other", label: "other (4)", watching: 4, nowPlaying: { provider: "youtube", id: "aaaaaaaaaaa" } },
      { id: "movies", label: "Movie night (7)", title: "Movie night", watching: 5, nowPlaying: { provider: "youtube", id: "dQw4w9WgXcQ" } },
      { id: "stream", label: "stream (2)", watching: 2, nowPlaying: { provider: "twitch", id: "somechannel" } },
    ],
    selected: "lobby",
  } as const;

  test("the room playing the page's video moves first with its watching count; the rest keep their order and labels", () => {
    expect(withWatching(list, [RICK])).toEqual({
      rooms: [
        { id: "movies", label: "Movie night · 5 watching · Join", title: "Movie night", watching: 5, nowPlaying: { provider: "youtube", id: "dQw4w9WgXcQ" } },
        list.rooms[0],
        list.rooms[1],
        list.rooms[3],
      ],
      selected: "lobby",
    });
  });

  test("an untitled match is named by its id; any embed on the page counts (Twitch live by channel)", () => {
    expect(withWatching(list, [RICK, LIVE]).rooms.map((r) => r.label)).toEqual([
      "Movie night · 5 watching · Join",
      "stream · 2 watching · Join",
      "lobby (3)",
      "other (4)",
    ]);
  });

  test("no match, no embeds, or a generic embed: the list unchanged", () => {
    expect(withWatching(list, [])).toEqual(list);
    expect(withWatching(list, [{ provider: "generic", url: "https://example.com/v", host: "example.com" }])).toEqual(list);
    expect(withWatching(list, [{ ...RICK, videoId: "bbbbbbbbbbb" }])).toEqual(list);
  });
});

describe("watchingBadge: the share's tab badge is the room's watcher count (OME-1637)", () => {
  const list = { rooms: [{ id: "movies", label: "m", watching: 5 }, { id: "empty", label: "e", watching: 0 }, { id: "tab", label: "tab" }], selected: "movies" };
  test("the shared room's watching count", () => {
    expect(watchingBadge(list, "movies")).toBe("5");
  });
  test("nobody watching, a tab-only room with no count, or an unknown room: no badge", () => {
    expect(watchingBadge(list, "empty")).toBe("");
    expect(watchingBadge(list, "tab")).toBe("");
    expect(watchingBadge(list, "nope")).toBe("");
  });
});

test("withRoomTabs: a listed room open in a tab keeps what GET /rooms said about it (OME-1637)", () => {
  const movies = { id: "movies", label: "Movie night (7)", title: "Movie night", watching: 5, nowPlaying: { provider: "youtube", id: "dQw4w9WgXcQ" } } as const;
  expect(withRoomTabs({ rooms: [movies], selected: "movies" }, { rooms: ["movies"], tokens: new Map() }).rooms).toEqual([movies]);
});
