import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { addToQueue } from "../src/queue";
import { loadRooms } from "../src/rooms";
import { STATUS_TEXT } from "../src/server-status";
import { shareEmbed } from "../src/share";

const BASE = "https://abc123.ngrok-free.app";
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const EMBED_URL = "https://www.youtube.com/embed/aqz-KE-bpKQ";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A server that accepted the connection and never answers. Ignores the abort signal, as a stuck fetch could. */
const hanging = () => mock<(url: string, init: RequestInit) => Promise<Response>>(() => new Promise<Response>(() => undefined));

/** Lets every settled promise run its callbacks. */
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

/** Resolves to "pending" if `promise` hasn't settled yet. */
async function peek<T>(promise: Promise<T>): Promise<T | "pending"> {
  const result = await Promise.race([promise, flush().then(() => "pending" as const)]);
  return result;
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("loadRooms timeout", () => {
  test("a server that never answers is reported unreachable after 8 s, and the request is aborted", async () => {
    const fetch = hanging();
    const probe = loadRooms({ baseUrl: BASE, fetch });
    jest.advanceTimersByTime(7_900);
    expect(await peek(probe)).toBe("pending");
    jest.advanceTimersByTime(200);
    expect(await probe).toEqual({ kind: "unreachable" });
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });

  test("an answer in time leaves no timer behind", async () => {
    const probe = await loadRooms({ baseUrl: BASE, fetch: () => Promise.resolve(json({ rooms: [] })) });
    expect(probe.kind).toBe("ok");
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe.each([
  { name: "shareEmbed", post: shareEmbed },
  { name: "addToQueue", post: addToQueue },
])("$name timeout", ({ post }) => {
  test("a server that never answers shows the unreachable text after 10 s, and the request is aborted", async () => {
    const fetch = hanging();
    const result = post({ baseUrl: BASE, roomId: "lobby", url: EMBED_URL, token: TOKEN, fetch });
    jest.advanceTimersByTime(9_900);
    expect(await peek(result)).toBe("pending");
    jest.advanceTimersByTime(200);
    expect(await result).toEqual({ ok: false, message: STATUS_TEXT.unreachable(BASE) });
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });

  test("an answer in time leaves no timer behind", async () => {
    await post({ baseUrl: BASE, roomId: "lobby", url: EMBED_URL, token: TOKEN, fetch: () => Promise.resolve(json({})) });
    expect(jest.getTimerCount()).toBe(0);
  });
});
