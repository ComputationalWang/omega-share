import { describe, expect, mock, test } from "bun:test";
import { shareEmbed } from "../src/share";

const EMBED = { provider: "youtube", videoId: "aqz-KE-bpKQ", url: "https://www.youtube.com/embed/aqz-KE-bpKQ" } as const;
const BASE = "https://abc123.ngrok-free.app";
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const opaqueRedirect = (): Response => {
  const r = new Response(null, { status: 200 });
  Object.defineProperty(r, "type", { value: "opaqueredirect" });
  Object.defineProperty(r, "status", { value: 0 });
  Object.defineProperty(r, "ok", { value: false });
  return r;
};
const share = (fetch: (url: string, init: RequestInit) => Promise<Response>, over: { roomId?: string; url?: string; token?: string | null } = {}) =>
  shareEmbed({ baseUrl: BASE, roomId: over.roomId ?? "lobby", url: over.url ?? EMBED.url, token: over.token === undefined ? TOKEN : over.token, fetch });

describe("shareEmbed", () => {
  test("POSTs the embed URL to /rooms/:id/share with the share token and returns the server's embed", async () => {
    const fetch = mock<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(json({ ok: true, embed: EMBED })));
    expect(await share(fetch)).toEqual({ ok: true, embed: EMBED });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/rooms/lobby/share`);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("ngrok-skip-browser-warning")).toBe("1");
    expect(init?.credentials).toBe("include");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "")).toEqual({ url: EMBED.url });
  });

  test("the token travels only in the header, never in the URL or body", async () => {
    const fetch = mock<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(json({ ok: true, embed: EMBED })));
    await share(fetch);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).not.toContain(TOKEN);
    expect(typeof init?.body === "string" ? init.body : "").not.toContain(TOKEN);
  });

  test("without a token nothing is sent", async () => {
    const fetch = mock(() => Promise.resolve(json({ ok: true, embed: EMBED })));
    expect(await share(fetch, { token: null })).toEqual({ ok: false, message: "Open the room in a tab to share into it." });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a malformed token (header injection, wrong length) is never sent", async () => {
    const fetch = mock(() => Promise.resolve(json({ ok: true, embed: EMBED })));
    for (const token of ["short", `${TOKEN}\r\nX-Evil: 1`, `${TOKEN.slice(0, 20)}==`, ""]) {
      expect((await share(fetch, { token })).ok).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  const errors: readonly { name: string; response: () => Promise<Response>; message: string }[] = [
    {
      name: "a rejected token (401 unauthorized)",
      response: () => Promise.resolve(json({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, 401)),
      message: "The room didn't accept this share. Reload the room tab and try again.",
    },
    {
      name: "a 401 from an edge gate (not JSON)",
      response: () => Promise.resolve(new Response("Unauthorized", { status: 401 })),
      message: "Sign in to the room in a browser tab first.",
    },
    { name: "a redirect to a login page", response: () => Promise.resolve(opaqueRedirect()), message: "Sign in to the room in a browser tab first." },
    {
      name: "the tunnel is down (fetch throws)",
      response: () => Promise.reject(new TypeError("Failed to fetch")),
      message: `Can't reach ${BASE}. Is the tunnel running?`,
    },
    {
      name: "ngrok's HTML offline page",
      response: () => Promise.resolve(new Response("<!doctype html><title>ERR_NGROK_3200</title>", { status: 404, headers: { "content-type": "text/html" } })),
      message: `The server at ${BASE} isn't answering. The tunnel may be offline.`,
    },
    {
      name: "JSON off the contract",
      response: () => Promise.resolve(json({ ok: true, embed: { url: "javascript:alert(1)" } })),
      message: `The server at ${BASE} isn't answering. The tunnel may be offline.`,
    },
    {
      name: "a server error on the contract",
      response: () => Promise.resolve(json({ ok: false, error: { code: "room_not_found", message: "No such room" } }, 404)),
      message: "No such room",
    },
    {
      name: "the room's owner-only control policy (403 control_owner_only)",
      response: () => Promise.resolve(json({ ok: false, error: { code: "control_owner_only", message: "Only the owner can do that." } }, 403)),
      message: "Only the room's owner can change what plays in this room.",
    },
    {
      name: "a rate limit",
      response: () => Promise.resolve(json({ ok: false, error: { code: "rate_limited", message: "Slow down" } }, 429)),
      message: "Slow down",
    },
  ];
  for (const e of errors) {
    test(`reports ${e.name}`, async () => {
      expect(await share(mock(e.response))).toEqual({ ok: false, message: e.message });
    });
  }

  test("never sends an invalid room id or an oversized URL", async () => {
    const fetch = mock(() => Promise.resolve(json({ ok: true, embed: EMBED })));
    const r1 = await share(fetch, { roomId: "../admin" });
    const r2 = await share(fetch, { url: `https://youtu.be/${"a".repeat(3000)}` });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a 429 with Retry-After", () => {
  const limited = (retryAfter: string | null) => () => {
    const response = json({ ok: false, error: { code: "rate_limited", message: "too many shares, slow down" } }, 429);
    if (retryAfter !== null) response.headers.set("retry-after", retryAfter);
    return Promise.resolve(response);
  };
  const cases = [
    { retryAfter: "3", message: "Too many shares. Try again in 3 s" },
    { retryAfter: "1.2", message: "Too many shares. Try again in 2 s" },
    { retryAfter: "0", message: "Too many shares. Try again in 1 s" },
    { retryAfter: "60", message: "Too many shares. Try again in 60 s" },
    { retryAfter: "3600", message: "Too many shares. Try again in 60 s" },
    { retryAfter: null, message: "too many shares, slow down" },
    { retryAfter: "", message: "too many shares, slow down" },
    { retryAfter: "soon", message: "too many shares, slow down" },
    { retryAfter: "-5", message: "too many shares, slow down" },
    { retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT", message: "too many shares, slow down" },
  ];
  for (const c of cases) {
    test(`Retry-After ${JSON.stringify(c.retryAfter)} → "${c.message}"`, async () => {
      expect(await share(mock(limited(c.retryAfter)))).toEqual({ ok: false, message: c.message });
    });
  }
});
