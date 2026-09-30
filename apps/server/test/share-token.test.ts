import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ShareResponseSchema, ShareTokenSchema } from "@omega/shared";
import { Client, postShare, start, tokenOf, type ShareInit, type TestServer } from "./helpers";

const BODY = JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });

let t: TestServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
});

function server(): TestServer {
  if (t === null) throw new Error("no server");
  return t;
}
async function join(nickname: string, roomId = "lobby", headers?: Record<string, string>) {
  const r = await Client.join(server().ws(roomId), nickname, 0, headers);
  clients.push(r.client);
  return r;
}
const share = (init: ShareInit = {}) => postShare(server(), BODY, init);
async function errorCode(res: Response): Promise<string | null> {
  const body = v.parse(ShareResponseSchema, await res.json());
  return body.ok ? null : body.error.code;
}

describe("share token lifecycle (ADR 0015 §7)", () => {
  test("each member's snapshot carries its own token, and no one else ever sees it", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    const ta = tokenOf(a.snapshot);
    const tb = tokenOf(b.snapshot);
    expect(v.is(ShareTokenSchema, ta)).toBe(true);
    expect(ta).not.toBe(tb);
    await a.client.next("member-joined");
    expect(a.client.raw.join("\n")).not.toContain(tb);
    expect(b.client.raw.join("\n")).not.toContain(ta);
  });

  test("no token, or a malformed Authorization header, is 401 unauthorized with no broadcast (T-01, T-15)", async () => {
    // Distinct forwarded clients, so the per-client share bucket doesn't trip first.
    t = start({ trustProxy: true });
    const a = await join("alice");
    const token = tokenOf(a.snapshot);
    const auth = ["", `Basic ${token}`, `Bearer  ${token}`, `Bearer ${token}x`, "Bearer", token];
    const responses = await Promise.all(
      auth.map((authorization, i) =>
        share({ headers: { "x-forwarded-for": `198.51.100.${String(i)}`, ...(authorization === "" ? {} : { authorization }) } }),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("unauthorized");
    }
    const unknown = await share({ token: "A".repeat(22), headers: { "x-forwarded-for": "198.51.100.99" } });
    expect(unknown.status).toBe(401);
    await a.client.none("embed-changed");
  });

  test("the scheme is case-insensitive", async () => {
    t = start();
    const a = await join("alice");
    expect((await share({ headers: { authorization: `bearer ${tokenOf(a.snapshot)}` } })).status).toBe(200);
  });

  test("a valid token shares as that member", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    expect((await share({ token: tokenOf(b.snapshot) })).status).toBe(200);
    const changed = await a.client.next("embed-changed");
    expect(changed.by).toBe(b.snapshot.self);
    expect(changed.playback?.by).toBe(b.snapshot.self);
    const late = await join("late");
    expect(late.snapshot.room.playback?.by).toBe(b.snapshot.self);
  });

  test("a token dies when its member leaves; re-joining mints a new one (T-02)", async () => {
    t = start();
    const a = await join("alice");
    const first = tokenOf(a.snapshot);
    a.client.send({ type: "leave" });
    await Bun.sleep(30);
    expect((await share({ token: first })).status).toBe(401);
    a.client.send({ type: "join", nickname: "alice", avatar: 0 });
    const again = tokenOf(await a.client.next("snapshot"));
    expect(again).not.toBe(first);
    expect((await share({ token: again })).status).toBe(200);
  });

  test("a token dies when its socket closes (T-02)", async () => {
    t = start();
    const a = await join("alice");
    a.client.close();
    await a.client.closed;
    await Bun.sleep(30);
    expect((await share({ token: tokenOf(a.snapshot) })).status).toBe(401);
  });

  test("a token for one room can't share into another (T-03)", async () => {
    t = start({ rooms: ["lobby", "den"] });
    const a = await join("alice", "lobby");
    const d = await join("dora", "den");
    const res = await share({ roomId: "den", token: tokenOf(a.snapshot) });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
    await d.client.none("embed-changed");
    expect((await share({ roomId: "den", token: tokenOf(d.snapshot) })).status).toBe(200);
  });
});

describe("failed share attempts", () => {
  test("a garbage-token flood from a client can't lock out a member sharing from the same address", async () => {
    t = start();
    const token = tokenOf((await join("alice")).snapshot);
    for (let i = 0; i < 10; i++) await share({ token: "B".repeat(22) });
    expect((await share({ token })).status).toBe(200);
  });

  test("but it is itself rate limited, so token guessing stays bounded", async () => {
    t = start();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await share({ token: "B".repeat(22) })).status);
    expect(statuses[0]).toBe(401);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("share limits behind the tunnel (T-10)", () => {
  const as = (xff: string, token: string, roomId = "lobby"): ShareInit => ({ roomId, token, headers: { "x-forwarded-for": xff } });
  /** One member in each of `n` rooms (each joined from its own address), so the room limiter (burst 2) never trips. */
  async function spread(n: number): Promise<{ rooms: string[]; tokens: string[] }> {
    const rooms = Array.from({ length: n }, (_, i) => `r${String(i)}`);
    t = start({ trustProxy: true, rooms });
    const tokens = await Promise.all(
      rooms.map(async (id, i) => tokenOf((await join(`m${String(i)}`, id, { "x-forwarded-for": `203.0.113.${String(i)}` })).snapshot)),
    );
    return { rooms, tokens };
  }

  test("per member: many addresses don't lift the limit", async () => {
    t = start({ trustProxy: true });
    const token = tokenOf((await join("alice")).snapshot);
    const statuses: number[] = [];
    // The room limit (burst 2) is stricter than the member's (burst 5), so it trips first.
    for (let i = 0; i < 6; i++) statuses.push((await share(as(`198.51.100.${String(i)}`, token))).status);
    expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
  });

  test("per forwarded client: burst 5 across its members; another client is unaffected", async () => {
    const { rooms, tokens } = await spread(7);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await share(as(`6.6.6.${String(i)}, 198.51.100.1`, tokens[i] ?? "", rooms[i]))).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const res = await share(as("198.51.100.2", tokens[6] ?? "", rooms[6]));
    expect(res.status).toBe(200);
  });

  test("globally: burst 20 however many members, rooms and addresses", async () => {
    const { rooms, tokens } = await spread(25);
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await share(as(`198.51.100.${String(i)}`, tokens[i] ?? "", rooms[i]))).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toContain(429);
  });
});
