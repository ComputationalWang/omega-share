import { describe, expect, mock, test } from "bun:test";
import { addToQueue } from "../src/queue";

const EMBED = { provider: "youtube", videoId: "aqz-KE-bpKQ", url: "https://www.youtube.com/embed/aqz-KE-bpKQ" } as const;
const ITEM = { id: "q1", embed: EMBED, by: null } as const;
const BASE = "https://omega.example";
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const queue = (fetch: (url: string, init: RequestInit) => Promise<Response>, over: { roomId?: string; url?: string; token?: string | null } = {}) =>
  addToQueue({ baseUrl: BASE, roomId: over.roomId ?? "lobby", url: over.url ?? EMBED.url, token: over.token === undefined ? TOKEN : over.token, fetch });

describe("addToQueue (ADR 0031: POST /rooms/:id/queue)", () => {
  test("POSTs the embed URL to /rooms/:id/queue with the share token and returns the queued item", async () => {
    const fetch = mock<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(json({ ok: true, item: ITEM })));
    expect(await queue(fetch)).toEqual({ ok: true, item: ITEM });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/rooms/lobby/queue`);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init?.credentials).toBe("include");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "")).toEqual({ url: EMBED.url });
  });

  test("without a token, or with a malformed one, nothing is sent", async () => {
    const fetch = mock(() => Promise.resolve(json({ ok: true, item: ITEM })));
    expect(await queue(fetch, { token: null })).toEqual({ ok: false, message: "Open the room in a tab to share into it." });
    expect((await queue(fetch, { token: `${TOKEN}\r\nX-Evil: 1` })).ok).toBe(false);
    expect((await queue(fetch, { roomId: "../admin" })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  const errors: readonly { name: string; response: () => Promise<Response>; message: string }[] = [
    {
      name: "the room's owner-only control policy (403 control_owner_only)",
      response: () => Promise.resolve(json({ ok: false, error: { code: "control_owner_only", message: "Only the owner can do that." } }, 403)),
      message: "Only the room's owner can change what plays in this room.",
    },
    {
      name: "a full queue (409 queue_full)",
      response: () => Promise.resolve(json({ ok: false, error: { code: "queue_full", message: "Queue full" } }, 409)),
      message: "The room's queue is full. Try again after the next video starts.",
    },
    {
      name: "a rejected token",
      response: () => Promise.resolve(json({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, 401)),
      message: "The room didn't accept this share. Reload the room tab and try again.",
    },
    {
      name: "a server error on the contract",
      response: () => Promise.resolve(json({ ok: false, error: { code: "rate_limited", message: "Slow down" } }, 429)),
      message: "Slow down",
    },
    {
      name: "a pre-M6 server without the route (404, not JSON)",
      response: () => Promise.resolve(new Response("Not Found", { status: 404 })),
      message: `The server at ${BASE} isn't answering. The tunnel may be offline.`,
    },
    {
      name: "a share-shaped answer instead of a queue item",
      response: () => Promise.resolve(json({ ok: true, embed: EMBED })),
      message: `The server at ${BASE} isn't answering. The tunnel may be offline.`,
    },
    {
      name: "the server is unreachable",
      response: () => Promise.reject(new TypeError("Failed to fetch")),
      message: `Can't reach ${BASE}. Is the tunnel running?`,
    },
  ];
  for (const e of errors) {
    test(`reports ${e.name}`, async () => {
      expect(await queue(mock(e.response))).toEqual({ ok: false, message: e.message });
    });
  }
});

test("a 429 on Add to queue shows the same Retry-After wait as Share", async () => {
  const response = json({ ok: false, error: { code: "rate_limited", message: "too many videos queued, slow down" } }, 429);
  response.headers.set("retry-after", "4");
  expect(await queue(mock(() => Promise.resolve(response)))).toEqual({ ok: false, message: "Too many shares. Try again in 4 s" });
});
