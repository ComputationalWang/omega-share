import { describe, expect, mock, test } from "bun:test";
import { loadRooms } from "../src/rooms";

const BASE = "http://localhost:8787";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const FALLBACK = { rooms: [{ id: "lobby", label: "lobby" }], selected: "lobby" };

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
      rooms: [
        { id: "movies", label: "movies (7)" },
        { id: "lobby", label: "lobby (3)" },
      ],
      selected: "lobby",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/rooms`);
    expect(init?.method).toBe("GET");
  });

  test("selects the first room when lobby is not listed", async () => {
    const fetch = mock(() => Promise.resolve(json({ rooms: [{ id: "movies", memberCount: 0, seatedCount: 0 }] })));
    expect(await loadRooms({ baseUrl: BASE, fetch })).toEqual({
      rooms: [{ id: "movies", label: "movies (0)" }],
      selected: "movies",
    });
  });

  const fallbacks: readonly { name: string; response: () => Promise<Response> }[] = [
    { name: "a network error", response: () => Promise.reject(new TypeError("Failed to fetch")) },
    { name: "a non-2xx plain-text body", response: () => Promise.resolve(new Response("Forbidden origin", { status: 403 })) },
    { name: "a non-2xx JSON body on the contract", response: () => Promise.resolve(json({ rooms: [{ id: "x", memberCount: 1, seatedCount: 0 }] }, 500)) },
    { name: "bad JSON", response: () => Promise.resolve(new Response("{not json", { status: 200 })) },
    { name: "a schema failure", response: () => Promise.resolve(json({ rooms: [{ id: "../admin", memberCount: 1, seatedCount: 0 }] })) },
    { name: "an empty list", response: () => Promise.resolve(json({ rooms: [] })) },
  ];
  for (const f of fallbacks) {
    test(`falls back to the lobby alone on ${f.name}`, async () => {
      expect(await loadRooms({ baseUrl: BASE, fetch: mock(f.response) })).toEqual(FALLBACK);
    });
  }
});
