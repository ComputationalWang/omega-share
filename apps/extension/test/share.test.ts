import { describe, expect, mock, test } from "bun:test";
import { shareEmbed } from "../src/share";

const EMBED = { provider: "youtube", videoId: "aqz-KE-bpKQ", url: "https://www.youtube.com/embed/aqz-KE-bpKQ" } as const;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("shareEmbed", () => {
  test("POSTs the embed URL to /rooms/:id/share and returns the server's embed", async () => {
    const fetch = mock((_url: string, _init: RequestInit) => Promise.resolve(json({ ok: true, embed: EMBED })));
    const result = await shareEmbed({ baseUrl: "http://localhost:8787", roomId: "lobby", url: EMBED.url, fetch });
    expect(result).toEqual({ ok: true, embed: EMBED });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:8787/rooms/lobby/share");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ url: EMBED.url });
  });

  test("surfaces the server's error message", async () => {
    const fetch = mock(() => Promise.resolve(json({ ok: false, error: { code: "room_not_found", message: "No such room" } }, 404)));
    expect(await shareEmbed({ baseUrl: "http://localhost:8787", roomId: "nope", url: EMBED.url, fetch })).toEqual({
      ok: false,
      message: "No such room",
    });
  });

  const bad: readonly { name: string; response: () => Promise<Response> }[] = [
    { name: "non-JSON body", response: () => Promise.resolve(new Response("<html>502</html>", { status: 502 })) },
    { name: "JSON off the contract", response: () => Promise.resolve(json({ ok: true, embed: { url: "javascript:alert(1)" } })) },
  ];
  for (const b of bad) {
    test(`rejects a ${b.name}`, async () => {
      const fetch = mock(b.response);
      expect(await shareEmbed({ baseUrl: "http://localhost:8787", roomId: "lobby", url: EMBED.url, fetch })).toEqual({
        ok: false,
        message: "Unexpected response from the server.",
      });
    });
  }

  test("reports an unreachable server", async () => {
    const fetch = mock(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await shareEmbed({ baseUrl: "http://localhost:8787", roomId: "lobby", url: EMBED.url, fetch })).toEqual({
      ok: false,
      message: "Could not reach the server.",
    });
  });

  test("never sends an invalid room id or an oversized URL", async () => {
    const fetch = mock(() => Promise.resolve(json({ ok: true, embed: EMBED })));
    const r1 = await shareEmbed({ baseUrl: "http://localhost:8787", roomId: "../admin", url: EMBED.url, fetch });
    const r2 = await shareEmbed({ baseUrl: "http://localhost:8787", roomId: "lobby", url: `https://youtu.be/${"a".repeat(3000)}`, fetch });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
