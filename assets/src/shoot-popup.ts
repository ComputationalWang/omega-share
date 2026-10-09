// Set (j) follow-up (OME-532): the Web Store's share screenshot shows the real extension popup, not a mock-up. This boots a
// throwaway server (scratch DB holding one public room, "Movie night", with three members), serves a page with a YouTube
// embed and a stand-in room tab at /r/movie-night holding the share token the server gave Juno (the popup enables Share and
// Add to queue only for a room open in a tab, as in real use), loads the e2e build of the extension in Chromium's new
// headless mode, opens the popup against that page, waits until Share and Add to queue are live and shoots the popup to
// preview/store-popup.png. preview/store.html places that image in screenshot 2.
// Run: bun run --filter @omega/extension build:e2e && bun assets/src/shoot-popup.ts && bun assets/src/shoot-ui.ts
// Ports default to the free alt set (4470 page, 8877 server); override with OMEGA_SHOT_PAGE_PORT / OMEGA_SHOT_SERVER_PORT.
import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID, SHARE_TOKEN_STORAGE_KEY } from "@omega/shared";
import { openDatabase } from "../../apps/server/src/store/db";
import { RoomStore } from "../../apps/server/src/store/rooms";

const ROOT = join(import.meta.dir, "..", "..");
const EXTENSION_DIR = join(ROOT, "apps/extension/.output/chrome-mv3-e2e");
const OUT = join(import.meta.dir, "..", "preview", "store-popup.png");
const PAGE_PORT = Number(process.env["OMEGA_SHOT_PAGE_PORT"] ?? 4470);
const SERVER_PORT = Number(process.env["OMEGA_SHOT_SERVER_PORT"] ?? 8877);
const SERVER = `http://localhost:${String(SERVER_PORT)}`;
const SITE = `http://localhost:${String(PAGE_PORT)}`;
const ROOM = "movie-night";

const scratch = mkdtempSync(join(tmpdir(), "omega-shot-"));
const dbPath = join(scratch, "rooms.db");
const db = openDatabase(dbPath);
const store = new RoomStore(db);
store.createRoom({ id: DEFAULT_ROOM_ID, title: "Lobby", createdAt: 1, layout: DEFAULT_LAYOUT });
store.createRoom({ id: ROOM, title: "Movie night", createdAt: 2, layout: DEFAULT_LAYOUT });
db.close();

const server = Bun.spawn(["bun", "src/index.ts"], {
  cwd: join(ROOT, "apps/server"),
  env: { ...process.env, PORT: String(SERVER_PORT), SITE_ORIGIN: SITE, DB_PATH: dbPath },
  stdout: "ignore",
  stderr: "inherit",
});
let shareToken = "";
const page = Bun.serve({
  port: PAGE_PORT,
  fetch: (req) => new URL(req.url).pathname.startsWith("/r/") ? new Response(
    `<!doctype html><title>Movie night</title><script>sessionStorage.setItem(${JSON.stringify(SHARE_TOKEN_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify({ roomId: ROOM, token: shareToken }))})</script>`,
    { headers: { "content-type": "text/html" } },
  ) : new Response(
    `<!doctype html><title>Sunset timelapse over the bay</title><h1>Sunset timelapse over the bay</h1>
     <iframe width="640" height="360" src="https://www.youtube.com/embed/sunsetBay40" title="Sunset timelapse"></iframe>`,
    { headers: { "content-type": "text/html" } },
  ),
});
const sockets: WebSocket[] = [];

try {
  for (let i = 0; ; i++) {
    if (await fetch(`${SERVER}/rooms`).then((r) => r.ok, () => false)) break;
    if (i > 100) throw new Error("server did not start");
    await Bun.sleep(100);
  }
  // Three members, so the room select reads like a room people are in.
  for (const [avatar, nickname] of ["Juno", "Wren", "Kit"].entries()) {
    const ws = new WebSocket(`ws://localhost:${String(SERVER_PORT)}/rooms/${ROOM}/ws`, { headers: { Origin: SITE } });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => { ws.send(JSON.stringify({ type: "join", nickname, avatar })); });
      ws.addEventListener("message", (ev) => { if (typeof ev.data === "string" && ev.data.includes('"snapshot"')) {
        const snapshot: unknown = JSON.parse(ev.data);
        if (shareToken === "" && typeof snapshot === "object" && snapshot !== null && "shareToken" in snapshot && typeof snapshot.shareToken === "string") shareToken = snapshot.shareToken;
        resolve();
      } });
      ws.addEventListener("close", () => { reject(new Error(`${nickname} could not join`)); });
    });
    sockets.push(ws);
  }

  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    viewport: { width: 400, height: 400 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    await context.route("https://www.youtube.com/**", (route) => route.fulfill({ body: "", contentType: "text/html" }));
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await sw.evaluate((url) => chrome.storage.local.set({ serverBaseUrl: url }), SERVER);
    const roomTab = await context.newPage();
    await roomTab.goto(`${SITE}/r/${ROOM}`);
    const target = await context.newPage();
    await target.goto(SITE);
    const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, `${SITE}/`);
    if (tabId === undefined) throw new Error("no tab for the video page");
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html?tabId=${String(tabId)}`);
    await popup.getByTestId("embed-item").first().waitFor();
    await popup.getByTestId("room-select").selectOption(ROOM);
    await popup.locator("#queue:enabled").waitFor();
    await popup.locator("body").screenshot({ path: OUT });
  } finally {
    await context.close();
  }
} finally {
  for (const ws of sockets) ws.close();
  void page.stop(true);
  server.kill();
  await server.exited;
  rmSync(scratch, { recursive: true, force: true });
}

declare const chrome: {
  tabs: { query(q: Record<string, never>): Promise<{ id?: number; url?: string }[]> };
  storage: { local: { set(items: Record<string, string>): Promise<void> } };
};
