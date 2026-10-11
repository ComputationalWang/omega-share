// Generic tier policy on real server processes (OME-294, ADR 0024 §2, §4–§6). Two servers of our own, so the
// switch and the denylist never reach the lobby server: one with GENERIC_EMBEDS=on (the default) and a denylist,
// one with GENERIC_EMBEDS=off. Every refused URL must get `unsupported_url` and leave the room's embed alone;
// the CSP header's frame-src follows the switch. Both ports come from the agent's port block (OME-821).
import type { ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { DEFAULT_ROOM_ID, parseServerMessage, type RoomState } from "@omega/shared";
import { PORTS, ROOT } from "./support/apps";
import { signalOwned, spawnOwned } from "./support/owned";
import { EMBED_URL } from "./support/network";
import { expect, test } from "./support/csp";

const ON_PORT = PORTS.genericOn;
const OFF_PORT = PORTS.genericOff;
/** The site's own host: the generic tier refuses it and its subdomains (ADR 0024 §2). */
const SITE_ORIGIN = "https://watch.omega-fixture.org";
const DENIED = "denied-videos.org";
const GENERIC_URL = "https://video.omega-fixture.org/embed/42";
const SYNCED_FRAMES = "frame-src https://www.youtube-nocookie.com https://player.twitch.tv https://player.vimeo.com";

class Proc {
  output = "";
  readonly child: ChildProcess;
  constructor(
    readonly port: number,
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawnOwned(port, "bun", ["apps/server/src/index.ts"], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.on("data", (d: Buffer) => (this.output += d.toString()));
    this.child.stderr?.on("data", (d: Buffer) => (this.output += d.toString()));
  }
  async ready(port: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) throw new Error(`server exited ${String(this.child.exitCode)}:\n${this.output}`);
      // Our child's own startup line: a stale server on the port would answer too.
      if (this.output.includes(`omega-share server on http://127.0.0.1:${String(port)}/`)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.stop();
    throw new Error(`server not ready in 30 s:\n${this.output}`);
  }
  stop(): void {
    if (this.child.pid === undefined || this.child.exitCode !== null) return;
    signalOwned(this.child, this.port, "SIGKILL");
  }
}

function start(port: number, env: NodeJS.ProcessEnv): Proc {
  return new Proc(port, { PORT: String(port), HOST: "127.0.0.1", SITE_ORIGIN, DB_PATH: ":memory:", ...env });
}

interface Member {
  readonly token: string;
  /** The room as this member's last snapshot or embed-changed left it. */
  readonly embed: () => RoomState["embed"];
  readonly close: () => void;
}

/** Joins the lobby of the server on `port` over a raw WebSocket and keeps it open (the share token lives as long). */
function join(port: number, nickname: string): Promise<Member> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/rooms/${DEFAULT_ROOM_ID}/ws`);
    let embed: RoomState["embed"] = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no snapshot within 10 s"));
    }, 10_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "join", nickname, avatar: 0 }));
    });
    ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (msg?.type === "embed-changed") embed = msg.embed;
      if (msg?.type !== "snapshot") return;
      clearTimeout(timer);
      embed = msg.room.embed;
      if (msg.shareToken === undefined) reject(new Error("snapshot carried no shareToken"));
      else resolve({ token: msg.shareToken, embed: () => embed, close: () => { ws.close(); } });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
  });
}

/** One POST to the lobby's share endpoint, sent from the loopback address `from` (the share limiters key by it). */
function post(port: number, token: string, url: string, from: string): Promise<{ status: number; body: unknown }> {
  const data = JSON.stringify({ url });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        localAddress: from,
        method: "POST",
        path: `/rooms/${DEFAULT_ROOM_ID}/share`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * POSTs a share, waiting out the share limiters (429, for the `retryAfterMs` they name) so every URL gets a real
 * verdict. `from` picks the loopback source address: Linux routes all of 127/8 to lo, so each address is its own
 * client to the per-client limiter (OME-341). The limiters themselves are abuse.e2e.ts's job.
 */
async function share(port: number, token: string, url: string, from = "127.0.0.1"): Promise<{ status: number; body: unknown }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await post(port, token, url, from);
    if (res.status !== 429) return res;
    if (Date.now() > deadline) throw new Error(`still rate limited after 30 s: ${url}`);
    const error: unknown = typeof res.body === "object" && res.body !== null ? Reflect.get(res.body, "error") : null;
    const wait: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "retryAfterMs") : null;
    await new Promise((r) => setTimeout(r, (typeof wait === "number" ? wait : 1_000) + 50));
  }
}

/** Sharers in the room at once, well under MAX_ROOM_MEMBERS with the watching member. */
const BATCH = 8;

const UNSUPPORTED = { ok: false, error: { code: "unsupported_url" } };

// The acceptance list (OME-294 + OME-302), each refused by the GENERIC_EMBEDS=on server.
const REFUSED: readonly (readonly [string, string])[] = [
  ["http:", "http://video.omega-fixture.org/embed/42"],
  ["javascript:", "javascript:alert(document.domain)"],
  ["data:", "data:text/html,<script>alert(1)</script>"],
  ["userinfo", "https://user:pw@video.omega-fixture.org/embed/42"],
  ["userinfo, user only", "https://user@video.omega-fixture.org/embed/42"],
  ["IPv4 literal", "https://93.184.216.34/embed/42"],
  ["IPv4 loopback", "https://127.0.0.1/embed/42"],
  ["IPv4 as one number", "https://2130706433/embed/42"],
  ["IPv6 literal", "https://[2606:2800:220:1:248:1893:25c8:1946]/embed/42"],
  ["IPv6 loopback", "https://[::1]/embed/42"],
  ["localhost", "https://localhost/embed/42"],
  ["localhost subdomain", "https://video.localhost/embed/42"],
  [".local", "https://nas.local/embed/42"],
  [".internal", "https://media.corp.internal/embed/42"],
  ["non-default port", "https://video.omega-fixture.org:8443/embed/42"],
  ["IPv4 in hex", "https://0x7f.1/embed/42"],
  ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/embed/42"],
  [".lan", "https://tv.lan/embed/42"],
  [".home.arpa", "https://nas.home.arpa/embed/42"],
  ["IP-in-DNS (nip.io)", "https://127.0.0.1.nip.io/embed/42"],
  ["a synced provider's host that isn't a valid player", "https://www.youtube.com/feed/trending"],
  ["a Twitch clip", "https://clips.twitch.tv/SomeClip"],
  ["our own host", `${SITE_ORIGIN}/r/lobby`],
  ["our own host, uppercase", "https://WATCH.Omega-Fixture.org/r/lobby"],
  ["our own host, trailing dot", "https://watch.omega-fixture.org./r/lobby"],
  ["our own host's subdomain", "https://cdn.watch.omega-fixture.org/v.mp4"],
  ["denylisted host", `https://${DENIED}/embed/42`],
  ["denylisted host's subdomain", `https://player.${DENIED}/embed/42`],
];

test.describe("generic tier policy on real servers", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let on: Proc | undefined;
  let off: Proc | undefined;

  test.beforeAll(async () => {
    on = start(ON_PORT, { GENERIC_EMBEDS: "on", GENERIC_EMBED_DENYLIST: DENIED });
    off = start(OFF_PORT, { GENERIC_EMBEDS: "off" });
    await Promise.all([on.ready(ON_PORT), off.ready(OFF_PORT)]);
  });

  test.afterAll(() => {
    on?.stop();
    off?.stop();
  });

  test("GENERIC_EMBEDS=on: every unsafe URL gets unsupported_url and the room's embed is unchanged", async ({}, info) => {
    const member = await join(ON_PORT, "policy-on");
    try {
      // A safe generic URL is accepted first, so "unchanged" means it is still there after every refusal.
      const ok = await share(ON_PORT, member.token, GENERIC_URL);
      expect(ok).toEqual({ status: 200, body: { ok: true, embed: { provider: "generic", host: "video.omega-fixture.org", url: GENERIC_URL } } });
      await expect.poll(() => member.embed()).toMatchObject({ provider: "generic", url: GENERIC_URL });

      // Each refused URL comes from a member and an address of its own, so no verdict waits on another's share
      // bucket. In batches: the room holds MAX_ROOM_MEMBERS.
      const verdicts: { case: string; url: string; status: number; body: unknown }[] = [];
      for (let start = 0; start < REFUSED.length; start += BATCH) {
        const batch = REFUSED.slice(start, start + BATCH).map(async ([name, url], j) => {
          const i = start + j;
          const sharer = await join(ON_PORT, `policy-on-${String(i)}`);
          try {
            return { case: name, url, ...(await share(ON_PORT, sharer.token, url, `127.0.0.${String(i + 2)}`)) };
          } finally {
            sharer.close();
          }
        });
        verdicts.push(...(await Promise.all(batch)));
      }
      await info.attach("generic-on-verdicts.json", { body: JSON.stringify(verdicts, null, 2), contentType: "application/json" });
      for (const v of verdicts) {
        expect([v.case, v.status]).toEqual([v.case, 400]);
        expect(v.body).toMatchObject(UNSUPPORTED);
      }
      expect(member.embed()).toMatchObject({ provider: "generic", url: GENERIC_URL });
    } finally {
      member.close();
    }
  });

  test("GENERIC_EMBEDS=off: a safe generic URL gets unsupported_url; YouTube still shares", async () => {
    const member = await join(OFF_PORT, "policy-off");
    try {
      expect(await share(OFF_PORT, member.token, GENERIC_URL)).toMatchObject({ status: 400, body: UNSUPPORTED });
      expect(await share(OFF_PORT, member.token, "https://videos.example-host.net/embed/abc")).toMatchObject({ status: 400, body: UNSUPPORTED });
      expect(member.embed()).toBeNull();
      const yt = await share(OFF_PORT, member.token, EMBED_URL);
      expect(yt).toMatchObject({ status: 200, body: { ok: true, embed: { provider: "youtube" } } });
    } finally {
      member.close();
    }
  });

  test("CSP frame-src: https: with the switch on, only the three provider origins with it off", async ({ request }, info) => {
    // Every route carries the same header: the health check, the site's paths (404 without STATIC_DIR) and the API.
    const csp = async (port: number): Promise<string> => {
      const policies = new Set<string>();
      for (const path of ["/healthz", "/", `/r/${DEFAULT_ROOM_ID}`, `/rooms/${DEFAULT_ROOM_ID}/share`]) {
        policies.add((await request.get(`http://127.0.0.1:${String(port)}${path}`)).headers()["content-security-policy"] ?? "");
      }
      expect(policies.size, `one policy on every route of :${String(port)}`).toBe(1);
      return [...policies][0] ?? "";
    };
    const [withGeneric, syncedOnly] = [await csp(ON_PORT), await csp(OFF_PORT)];
    await info.attach("csp-headers.json", { body: JSON.stringify({ on: withGeneric, off: syncedOnly }, null, 2), contentType: "application/json" });
    const frameSrc = (policy: string) => policy.split(";").map((d) => d.trim()).filter((d) => d.startsWith("frame-src "));
    expect(frameSrc(withGeneric)).toEqual([`${SYNCED_FRAMES} https:`]);
    expect(frameSrc(syncedOnly)).toEqual([SYNCED_FRAMES]);
  });
});
