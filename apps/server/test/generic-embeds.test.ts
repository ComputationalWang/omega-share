import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import * as v from "valibot";
import { ShareResponseSchema } from "@omega/shared";
import type { ServerOptions } from "../src/server";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

/** A generic-tier URL (ADR 0024 §1) and the embed it canonicalises to. */
const GENERIC_URL = "https://Videos.Example-Host.net:443/embed/abc?t=10#start";
const GENERIC = { provider: "generic", host: "videos.example-host.net", url: "https://videos.example-host.net/embed/abc?t=10#start" };
const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PUBLIC_ORIGIN = "https://quiet-otter.ngrok-free.app";

let t: TestServer | null = null;
let db: Database | null = null;
let dir: string | null = null;
const clients: Client[] = [];

async function stop(): Promise<void> {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
  db?.close();
  db = null;
}

afterEach(async () => {
  await stop();
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function boot(opts: Partial<ServerOptions> = {}): TestServer {
  t = start(opts);
  return t;
}

/** Boots on a file DB, like `index.ts`; a second call after `stop()` is a restart. */
function bootWithDb(opts: Partial<ServerOptions> = {}): TestServer {
  dir ??= mkdtempSync(joinPath(tmpdir(), "omega-generic-"));
  db = openDatabase(joinPath(dir, "omega.db"));
  return boot({ store: new RoomStore(db), ...opts });
}

async function join(server: TestServer, nickname: string) {
  const r = await Client.join(server.ws(), nickname);
  clients.push(r.client);
  return r;
}

/** Joins as `nickname` and shares `url`; resolves with the parsed response and its status. */
async function share(server: TestServer, url: string, nickname = "alice") {
  const member = await join(server, nickname);
  const res = await postShare(server, JSON.stringify({ url }), { token: tokenOf(member.snapshot) });
  const body = v.parse(ShareResponseSchema, await res.json());
  return { status: res.status, body, member };
}

const unsupported = { ok: false, error: { code: "unsupported_url" } };

describe("POST /rooms/:id/share accepts the generic tier (ADR 0024)", () => {
  test("a valid generic URL is shared canonically and broadcast with playback null", async () => {
    const server = boot();
    const watcher = await join(server, "bob");
    const { status, body } = await share(server, GENERIC_URL);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, embed: GENERIC });

    const changed = await watcher.client.next("embed-changed");
    expect(changed.embed).toEqual(GENERIC);
    expect(changed.playback).toBeNull();

    const late = await join(server, "carol");
    expect(late.snapshot.room.embed).toEqual(GENERIC);
    expect(late.snapshot.room.playback).toBeNull();
  });

  test("synced providers still become synced embeds with playback", async () => {
    const server = boot();
    const { status, body, member } = await share(server, YOUTUBE_URL);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, embed: { provider: "youtube" } });
    expect((await member.client.next("embed-changed")).playback).toMatchObject({ action: "load" });
  });

  test.each([
    "http://videos.example-host.net/embed/abc",
    "javascript:alert(1)",
    "data:text/html,<p>hi</p>",
    "https://user:pw@videos.example-host.net/",
    "https://videos.example-host.net:8443/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://[::1]/",
    "https://localhost/",
    "https://router.lan/",
    "https://lvh.me/",
    "https://clips.twitch.tv/SomeClip",
    "not a url",
  ])("a bad URL is refused with unsupported_url: %p", async (url) => {
    const server = boot();
    const { status, body } = await share(server, url);
    expect(status).toBe(400);
    expect(body).toMatchObject(unsupported);
  });

  test("our own hosts and their subdomains are refused", async () => {
    const server = boot({ publicOrigin: PUBLIC_ORIGIN, siteOrigin: "https://watch.omega-site.org" });
    for (const [i, url] of [
      `${PUBLIC_ORIGIN}/rooms/lobby`,
      "https://cdn.quiet-otter.ngrok-free.app/x",
      "https://watch.omega-site.org/",
    ].entries()) {
      const { status, body } = await share(server, url, `m${String(i)}`);
      expect([url, status]).toEqual([url, 400]);
      expect(body).toMatchObject(unsupported);
    }
  });
});

describe("GENERIC_EMBEDS=off (ADR 0024 §5)", () => {
  test("a generic URL is refused with unsupported_url; synced providers still work", async () => {
    const server = boot({ genericEmbeds: false });
    const generic = await share(server, GENERIC_URL, "alice");
    expect(generic.status).toBe(400);
    expect(generic.body).toMatchObject(unsupported);
    const synced = await share(server, YOUTUBE_URL, "bob");
    expect(synced.status).toBe(200);
  });
});

describe("host denylist hook (ADR 0024 §6)", () => {
  test("a denied host and its subdomains get unsupported_url; other hosts pass", async () => {
    const server = boot({ genericEmbedDenylist: ["example-host.net"] });
    const denied = await share(server, GENERIC_URL, "alice");
    expect(denied.status).toBe(400);
    expect(denied.body).toMatchObject(unsupported);
    const apex = await share(server, "https://example-host.net/v", "bob");
    expect(apex.body).toMatchObject(unsupported);
    // Only whole labels match: "notexample-host.net" is not under "example-host.net".
    const other = await share(server, "https://notexample-host.net/v", "carol");
    expect(other.status).toBe(200);
  });

  test("the denylist applies to the generic tier only", async () => {
    const server = boot({ genericEmbedDenylist: ["youtube.com"] });
    const { status } = await share(server, YOUTUBE_URL);
    expect(status).toBe(200);
  });
});

describe("a generic embed's sync state stays inert (ADR 0024 §7)", () => {
  test("control gets error no_embed, even with the embed's exact url, and nothing is broadcast", async () => {
    const server = boot();
    const watcher = await join(server, "bob");
    const { member } = await share(server, "https://videos.example-host.net/e/1");
    await watcher.client.next("embed-changed");
    member.client.send({ type: "control", url: "https://videos.example-host.net/e/1", playing: false, position: 30 });
    expect((await member.client.next("error")).code).toBe("no_embed");
    await watcher.client.none("playback");
  });

  test("status { catching } is ignored while the embed is generic", async () => {
    const server = boot({ statusIntervalMs: 10 });
    const watcher = await join(server, "bob");
    const { member } = await share(server, GENERIC_URL);
    await watcher.client.next("embed-changed");
    member.client.send({ type: "status", catching: true });
    await watcher.client.none("member-status");
    const late = await join(server, "carol");
    expect(late.snapshot.room.members.some((m) => m.catching === true)).toBe(false);
  });
});

describe("a generic embed persists like any other (OME-280)", () => {
  test("it comes back after a restart, still with playback null", async () => {
    let server = bootWithDb();
    expect((await share(server, GENERIC_URL)).status).toBe(200);
    await stop();

    server = bootWithDb();
    const { snapshot } = await join(server, "bob");
    expect(snapshot.room.embed).toEqual(GENERIC);
    expect(snapshot.room.playback).toBeNull();
  });

  test("with GENERIC_EMBEDS=off it is restored as embed null, and comes back when switched on again", async () => {
    let server = bootWithDb();
    expect((await share(server, GENERIC_URL)).status).toBe(200);
    await stop();

    server = bootWithDb({ genericEmbeds: false });
    const off = await join(server, "bob");
    expect(off.snapshot.room.embed).toBeNull();
    expect(off.snapshot.room.playback).toBeNull();
    await stop();

    server = bootWithDb();
    expect((await join(server, "carol")).snapshot.room.embed).toEqual(GENERIC);
  });

  test("a host denied after it was shared is restored as embed null", async () => {
    let server = bootWithDb();
    expect((await share(server, GENERIC_URL)).status).toBe(200);
    await stop();

    server = bootWithDb({ genericEmbedDenylist: ["example-host.net"] });
    expect((await join(server, "bob")).snapshot.room.embed).toBeNull();
  });
});

describe("CSP frame-src follows the kill switch (ADR 0024 §4)", () => {
  const directive = (policy: string, name: string): string[] =>
    policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .find(([n]) => n === name)
      ?.slice(1) ?? [];
  const SYNCED_FRAMES = ["https://www.youtube-nocookie.com", "https://player.twitch.tv", "https://player.vimeo.com"];
  const SCRIPTS = [
    "'self'",
    "https://www.youtube.com/iframe_api",
    "https://www.youtube.com/s/player/",
    "https://player.twitch.tv/js/embed/v1.js",
    "https://player.vimeo.com/api/player.js",
  ];

  async function policy(genericEmbeds: boolean): Promise<string[]> {
    const server = boot({ genericEmbeds });
    const csps: string[] = [];
    // A Hono route, and one answered before routing (421 on a bad Host).
    for (const headers of [{}, { host: "evil.example" }]) {
      const res = await fetch(`${server.http}/healthz`, { headers });
      csps.push(res.headers.get("content-security-policy") ?? "");
    }
    await stop();
    return csps;
  }

  test("on: frame-src adds https:, script-src unchanged", async () => {
    for (const csp of await policy(true)) {
      expect(directive(csp, "frame-src")).toEqual([...SYNCED_FRAMES, "https:"]);
      expect(directive(csp, "script-src")).toEqual(SCRIPTS);
    }
  });

  test("off: frame-src drops https:, script-src unchanged", async () => {
    for (const csp of await policy(false)) {
      expect(directive(csp, "frame-src")).toEqual(SYNCED_FRAMES);
      expect(directive(csp, "script-src")).toEqual(SCRIPTS);
    }
  });
});
