// Restart persistence (OME-281, OME-277/OME-280): rooms, layout and the last embed live in a SQLite file, so a server
// that is killed and started again on the same DB_PATH comes back with the same TV and the same layout, and the
// clients' own reconnect carries them back into the room without a page reload. The DB is seeded with the set (g)
// test layout, so the same server also proves a layout that only exists in the DB renders and its seats work.
//
// This spec owns its server and its site (own ports, a temp DB file), so killing the server never touches the shared
// lobby server the other specs use. CSP here is index.html's meta policy only: Vite dev never sends the server's
// header-only directives (Trusted Types), which the tunnel lane covers. The site is the Vite dev server pointed at that server (VITE_SERVER_URL), the same
// pattern as playwright.config.ts; no production build is needed. The seeded layout is not the default, so a restart
// that lost the DB would show.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID, parseServerMessage, type RoomLayout, type RoomState } from "@omega/shared";
import { ROOT } from "./support/apps";
import { EMBED_URL } from "./support/network";
import { clickSettled, joinRoom, leaveAll } from "./support/room";
import { site } from "./support/selectors";
import { scene, seatedBetween, selfId } from "./support/scene";
import { SET_G, SET_G_SEAT_PIECE } from "./fixtures/layouts";
import { expect, test } from "./support/csp";

function portFrom(name: string, fallback: number): number {
  const raw = process.env[name];
  const port = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${name} must be a port number, got ${String(raw)}`);
  return port;
}

/** Alt ports next to the lobby pair (5173/8787); QA2's pair is 5183/8797 and is never used here. */
const SERVER_PORT = portFrom("OMEGA_PERSIST_SERVER_PORT", 8807);
const WEB_PORT = portFrom("OMEGA_PERSIST_WEB_PORT", 5193);
const SERVER_URL = `http://localhost:${String(SERVER_PORT)}`;
const WEB_URL = `http://localhost:${String(WEB_PORT)}`;
const ROOM_URL = `${WEB_URL}/r/${DEFAULT_ROOM_ID}`;
/** YT.PlayerState */
const PLAYING = 1;
const PAUSED = 2;

class Proc {
  output = "";
  readonly child: ChildProcess;
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    // Own process group, so stop() reaches what a wrapper (`bunx vite`) started, not just the wrapper.
    this.child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.child.stdout?.on("data", (d: Buffer) => (this.output += d.toString()));
    this.child.stderr?.on("data", (d: Buffer) => (this.output += d.toString()));
  }
  /** Waits until `ready()` says so; fails fast if the child dies first (a stale process on the port can't pass for ours). */
  async waitFor(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) throw new Error(`${what} exited ${String(this.child.exitCode)}:\n${this.output}`);
      if (await ready()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.stop("SIGKILL");
    throw new Error(`${what} not ready in 30 s:\n${this.output}`);
  }
  /** Signals the whole process group; escalates to SIGKILL if it hasn't exited within 5 s. */
  stop(signal: NodeJS.Signals): Promise<void> {
    const c = this.child;
    if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) return Promise.resolve();
    const pid = c.pid;
    const kill = (s: NodeJS.Signals): void => {
      try {
        process.kill(-pid, s);
      } catch {
        // already gone
      }
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        kill("SIGKILL");
      }, 5_000);
      c.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      kill(signal);
    });
  }
}

/** Joins as a throwaway member and returns its snapshot and share token (the token works while its socket is open). */
function observe(nickname: string, keepOpen = false): Promise<{ room: RoomState; shareToken: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${SERVER_URL.replace(/^http/, "ws")}/rooms/${DEFAULT_ROOM_ID}/ws`);
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
      if (msg?.type !== "snapshot") return;
      clearTimeout(timer);
      if (!keepOpen) ws.close();
      if (msg.shareToken === undefined) reject(new Error("snapshot carried no shareToken"));
      else resolve({ room: msg.room, shareToken: msg.shareToken, close: () => { ws.close(); } });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
  });
}

test.describe("restart persistence (own server, own DB file)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let dir = "";
  let dbPath = "";
  let server: Proc | undefined;
  let web: Proc | undefined;

  const startServer = async (): Promise<Proc> => {
    const proc = new Proc("bun", ["apps/server/src/index.ts"], ROOT, {
      PORT: String(SERVER_PORT),
      HOST: "127.0.0.1",
      SITE_ORIGIN: WEB_URL,
      DB_PATH: dbPath,
    });
    // Our child's own startup line: a stale server on the port would answer /healthz too.
    await proc.waitFor("server", () => proc.output.includes(`omega-share server on http://127.0.0.1:${String(SERVER_PORT)}/`));
    return proc;
  };

  test.beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omega-persist-"));
    dbPath = join(dir, "omega.db");
    const seed = spawnSync("bun", ["e2e/fixtures/seed-room.ts", dbPath], { cwd: ROOT, encoding: "utf8" });
    if (seed.status !== 0) throw new Error(`seeding the DB failed:\n${seed.stdout}\n${seed.stderr}`);
    server = await startServer();
    const vite = new Proc("bunx", ["vite", "--port", String(WEB_PORT), "--strictPort", "--host", "localhost"], join(ROOT, "apps/web"), {
      VITE_SERVER_URL: SERVER_URL,
    });
    web = vite;
    await vite.waitFor("vite", async () => (await fetch(WEB_URL).then((r) => r.ok, () => false)) && vite.output.includes(String(WEB_PORT)));
  });

  test.afterAll(async () => {
    await Promise.all([server?.stop("SIGKILL"), web?.stop("SIGTERM")]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a set (g) layout seeded in the DB renders, and sitting works on its seats", async ({ browser }) => {
    const served = await observe("observer-layout");
    expect(served.room.layout, "the layout comes from the DB, not DEFAULT_LAYOUT").toEqual(SET_G);

    const clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 2, nicknamePrefix: "layout" });
    const [a, b] = clients;
    if (a === undefined || b === undefined) throw new Error("expected two clients");
    try {
      // Every seat-giving set (g) piece is drawn (back and front), from the lazy atlas.
      for (const c of clients) {
        await expect(c.page.locator(site.seat)).toHaveCount(8);
        await expect
          .poll(async () => {
            const order = await scene(c.page);
            return SET_G_SEAT_PIECE.every((p) => order.includes(`furniture/${p}/back`) && order.includes(`furniture/${p}/front`));
          }, { timeout: 15_000 })
          .toBe(true);
      }

      // A sits on a sofa (seat 2), B on the wingback (seat 6); each is drawn between its piece's back and front.
      for (const [c, seat] of [[a, 2], [b, 6]] as const) {
        await clickSettled(c.page, c.page.locator(`${site.seat}[data-seat="${String(seat)}"]`));
        await expect(c.page.locator(`[data-seat="${String(seat)}"]`)).toHaveClass(/mine/);
        const self = await selfId(c.page);
        const piece = SET_G_SEAT_PIECE[seat] ?? "";
        await expect.poll(() => seatedBetween(c.page, self, piece)).toBe(true);
      }
      await expect(a.page.locator('[data-seat="6"]')).toHaveAttribute("aria-label", /taken by layout-2/);
      await expect(b.page.locator('[data-seat="2"]')).toHaveAttribute("aria-label", /taken by layout-1/);
      await test.info().attach("db-layout-set-g-seated.png", { body: await a.page.locator(site.room).screenshot(), contentType: "image/png" });
    } finally {
      await leaveAll(clients);
    }
  });

  test("a killed and restarted server restores the TV paused at 0 and the same layout; clients reconnect and can sit", async ({ browser }) => {
    const before = await observe("observer-before");
    expect(before.room.embed).toBeNull();
    const layoutBefore: RoomLayout | undefined = before.room.layout;
    expect(layoutBefore, "the seeded layout is served").toBeDefined();
    expect(layoutBefore).not.toEqual(DEFAULT_LAYOUT);

    const clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 2, nicknamePrefix: "persist" });
    const [a, b] = clients;
    if (a === undefined || b === undefined) throw new Error("expected two clients");
    try {
      // Share the embed, as the extension does: POST with the member's share token.
      const sharer = await observe("sharer", true);
      const res = await fetch(`${SERVER_URL}/rooms/${DEFAULT_ROOM_ID}/share`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${sharer.shareToken}` },
        body: JSON.stringify({ url: EMBED_URL }),
      });
      sharer.close();
      expect(res.status).toBe(200);

      // Both members watch it play, and it has run for a moment (so "paused at 0" isn't just "hasn't started").
      for (const c of clients) {
        await expect(c.page.locator(site.sharedVideo)).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => c.page.evaluate(() => window.__fakeYt?.state ?? null), { timeout: 15_000 }).toBe(PLAYING);
      }
      await expect.poll(() => a.page.evaluate(() => window.__fakeYt?.currentTime ?? 0), { timeout: 10_000 }).toBeGreaterThan(1.5);
      const live = await observe("observer-live");
      const embedBefore = live.room.embed;
      expect(embedBefore).not.toBeNull();
      expect(live.room.playback?.playing).toBe(true);
      expect(live.room.layout).toEqual(layoutBefore);

      // Kill the server hard (no graceful shutdown) and bring it back on the same DB file and port.
      await server?.stop("SIGKILL");
      for (const c of clients) await expect(c.page.locator(site.connectionStatus)).not.toHaveText("", { timeout: 15_000 });
      server = await startServer();

      // The clients' own reconnect (capped backoff, <= 5 s) rejoins them. No reload.
      await expect(a.page.locator(site.connectionStatus)).toHaveText("", { timeout: 30_000 });
      await expect(b.page.locator(site.connectionStatus)).toHaveText("", { timeout: 30_000 });
      for (const c of clients) {
        await expect(c.page.locator(site.room)).toBeVisible();
        await expect(c.page.locator(site.nicknameTag, { hasText: "persist-1" })).toBeVisible();
        await expect(c.page.locator(site.nicknameTag, { hasText: "persist-2" })).toBeVisible();
      }

      // Server state: same embed, paused at 0, same layout.
      const after = await observe("observer-after");
      expect(after.room.embed).toEqual(embedBefore);
      expect(after.room.playback?.playing).toBe(false);
      expect(after.room.playback?.position).toBe(0);
      expect(after.room.layout).toEqual(layoutBefore);

      // Client state: the TV shows the same embed, paused at ~0, on both members.
      for (const c of clients) {
        await expect(c.page.locator(site.sharedVideo)).toBeVisible();
        await expect.poll(() => c.page.evaluate(() => window.__fakeYt?.state ?? null), { timeout: 15_000 }).toBe(PAUSED);
        const t = await c.page.evaluate(() => window.__fakeYt?.currentTime ?? -1);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(1);
      }
      await expect(a.page.locator(site.sharedVideo)).toHaveAttribute("src", /aqz-KE-bpKQ/);

      // Sitting still works on the restarted server, and the other member sees it.
      await clickSettled(a.page, a.page.locator(`${site.seat}[data-seat="0"]`));
      await expect(a.page.locator('[data-seat="0"]')).toHaveAttribute("data-occupied", "true");
      await expect(b.page.locator('[data-seat="0"]')).toHaveAttribute("data-occupied", "true");
      await expect(b.page.locator('[data-seat="0"]')).toHaveAttribute("aria-label", /taken by persist-1/);
      const self = await selfId(a.page);
      await expect.poll(() => seatedBetween(a.page, self, SET_G_SEAT_PIECE[0] ?? "")).toBe(true);
    } finally {
      await leaveAll(clients);
    }
  });
});
