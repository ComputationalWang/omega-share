import { describe, expect, mock, test } from "bun:test";
import { loadRooms } from "../src/rooms";

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
          { id: "movies", label: "movies (7)" },
          { id: "lobby", label: "lobby (3)" },
        ],
        selected: "lobby",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/rooms`);
    expect(init?.method).toBe("GET");
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
      list: { rooms: [{ id: "movies", label: "movies (0)" }], selected: "movies" },
    });
  });

  test("an empty list is still a working server: the lobby alone", async () => {
    expect(await loadRooms({ baseUrl: BASE, fetch: mock(() => Promise.resolve(json({ rooms: [] }))) })).toEqual({ kind: "ok", list: FALLBACK });
  });

  const outcomes: readonly { name: string; response: () => Promise<Response>; kind: string }[] = [
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
