// Room presets and saved layouts (OME-910): the create form's preset picker sends a preset id and the server resolves
// it; a layout saved from the owner's editor can start a later room (created as the empty preset, then the owner's first
// join sends one layout-set). Garbage in the saved-layouts key must not break the home page or creating a room.
//
// This spec owns its server and site (own ports, a temp DB), like persistence.e2e.ts: POST /rooms is rate limited to 2
// per client key, and the shared lobby server has no TRUST_PROXY, so every create from the browser would share one key.
// Here the server trusts a loopback X-Forwarded-For and every create gets an address of its own (the global bucket of
// 10 still covers this file's 9 creates). CSP here is index.html's meta policy only, as in persistence.e2e.ts.
import { spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_PRESET_IDS, RoomLayoutSchema, type RoomLayout, type RoomPresetId } from "@omega/shared";
import { devices, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import * as v from "valibot";
import { cellCenter } from "../apps/web/src/layout";
import { PORTS, ROOT } from "./support/apps";
import { expect, test, watchCsp } from "./support/csp";
import { stubExternalNetwork } from "./support/network";
import { signalOwned, spawnOwned } from "./support/owned";
import { site } from "./support/selectors";
import { openDirectory } from "./support/directory";
import { serverArgv } from "./support/server-cmd";

// In this agent's port block, between the fixture page (+0) and the tunnel lanes (+30…).
const SERVER_PORT = PORTS.fixtures + 20;
const WEB_PORT = PORTS.fixtures + 21;
const SERVER_URL = `http://localhost:${String(SERVER_PORT)}`;
const WEB_URL = `http://localhost:${String(WEB_PORT)}`;

const SAVED_KEY = "omega.savedLayouts.v1";
const id = (name: string): string => `[data-testid="${name}"]`;
const radio = (preset: string): string => id(`preset-${preset}`);

/** assets/presets/<id>.json, parsed with the contract's schema (read as files: Playwright's loader needs import attributes for JSON). */
const presetLayout = (preset: RoomPresetId): RoomLayout => v.parse(RoomLayoutSchema, JSON.parse(readFileSync(join(ROOT, "assets/presets", `${preset}.json`), "utf8")));

class Proc {
  output = "";
  readonly child: ChildProcess;
  constructor(
    readonly port: number,
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawnOwned(port, command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.on("data", (d: Buffer) => (this.output += d.toString()));
    this.child.stderr?.on("data", (d: Buffer) => (this.output += d.toString()));
  }
  async waitFor(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) throw new Error(`${what} exited ${String(this.child.exitCode)}:\n${this.output}`);
      if (await ready()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.stop();
    throw new Error(`${what} not ready in 30 s:\n${this.output}`);
  }
  stop(): Promise<void> {
    const c = this.child;
    if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      c.once("exit", () => {
        resolve();
      });
      signalOwned(c, this.port, "SIGKILL");
    });
  }
}

test.describe("room presets and saved layouts (own server and site)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(90_000);

  let dir = "";
  let server: Proc | undefined;
  let web: Proc | undefined;
  let contexts: BrowserContext[] = [];
  let nextAddr = 1;

  test.beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omega-presets-"));
    const db = join(dir, "omega.db");
    const seed = spawnSync("bun", ["e2e/fixtures/seed-rooms.ts", db], { cwd: ROOT, encoding: "utf8" });
    if (seed.status !== 0) throw new Error(`seeding the DB failed:\n${seed.stdout}\n${seed.stderr}`);
    const s = new Proc(SERVER_PORT, ...serverArgv(), ROOT, { PORT: String(SERVER_PORT), HOST: "127.0.0.1", SITE_ORIGIN: WEB_URL, TRUST_PROXY: "loopback", DB_PATH: db, ADMIN_SOCKET: "off" });
    server = s;
    await s.waitFor("server", () => s.output.includes(`omega-share server on http://127.0.0.1:${String(SERVER_PORT)}/`));
    const w = new Proc(WEB_PORT, "bunx", ["vite", "--port", String(WEB_PORT), "--strictPort", "--host", "localhost"], join(ROOT, "apps/web"), { VITE_SERVER_URL: SERVER_URL });
    web = w;
    await w.waitFor("vite", async () => (await fetch(WEB_URL).then((r) => r.ok, () => false)) && w.output.includes(String(WEB_PORT)));
  });

  test.afterAll(async () => {
    await Promise.all([server?.stop(), web?.stop()]);
    rmSync(dir, { recursive: true, force: true });
  });

  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    contexts = [];
  });

  /** A fresh context whose room creations each come from an address of their own (the server trusts a loopback X-Forwarded-For). */
  async function newPage(browser: Browser, options: BrowserContextOptions = {}): Promise<{ page: Page; errors: string[] }> {
    const context = await watchCsp(await browser.newContext(options));
    contexts.push(context);
    await stubExternalNetwork(context);
    await context.route(`${SERVER_URL}/rooms`, async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      const n = nextAddr++;
      return route.continue({ headers: { ...req.headers(), "x-forwarded-for": `198.18.${String(n >> 8)}.${String(n & 0xff)}` } });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    return { page, errors };
  }

  async function enter(page: Page, nickname = "owner"): Promise<void> {
    await page.locator(site.nicknameInput).fill(nickname);
    await page.locator(site.joinButton).click();
    await expect(page.locator(site.room)).toBeVisible();
  }

  /** The room's layout as the snapshot said (the dev handle, apps/web/src/main.ts `window.__omega.room`). */
  async function layoutOf(page: Page): Promise<RoomLayout> {
    return v.parse(RoomLayoutSchema, await roomField(page, "layout"));
  }

  async function roomField(page: Page, field: string): Promise<unknown> {
    return page.evaluate((field) => {
      const debug: unknown = Reflect.get(window, "__omega");
      const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
      if (typeof room !== "object" || room === null) return null;
      const state: unknown = Reflect.get(room, "state");
      const s: unknown = typeof state === "function" ? Reflect.apply(state, room, []) : null;
      const r: unknown = typeof s === "object" && s !== null ? Reflect.get(s, "room") : null;
      return typeof r === "object" && r !== null ? (Reflect.get(r, field) as unknown) : null;
    }, field);
  }

  async function createRoom(page: Page, title: string, choose: string | null): Promise<void> {
    await page.goto(`${WEB_URL}/`);
    await openDirectory(page);
    await expect(page.locator(radio("classic"))).toBeChecked();
    if (choose !== null) await page.locator(choose).check();
    await page.locator(site.createRoomTitle).fill(title);
    await page.locator(site.createRoomSubmit).click();
    await page.waitForURL(/\/r\/[a-z2-7]{26}$/);
    await enter(page);
  }

  test("the picker offers every preset with classic checked, and a created room starts from each preset's layout", async ({ browser }) => {
    const { page, errors } = await newPage(browser);
    await page.goto(`${WEB_URL}/`);
    await openDirectory(page);
    const radios = page.locator(`${id("preset-picker")} input[type=radio]`);
    await expect(radios).toHaveCount(ROOM_PRESET_IDS.length);
    const values = await radios.evaluateAll((rs) => rs.map((r) => (r instanceof HTMLInputElement ? r.value : "")));
    expect([...values].sort()).toEqual([...ROOM_PRESET_IDS].sort());
    await expect(page.locator(radio("classic"))).toBeChecked();
    // The untouched default (classic) is created by the #share= test below: this file's creates fill the global bucket
    // (ROOM_CREATE_GLOBAL_BURST, 10), so classic isn't created here as well.
    let theatreUrl = "";
    for (const preset of ROOM_PRESET_IDS.filter((p) => p !== "classic")) {
      await createRoom(page, `Room ${preset}`, radio(preset));
      expect(await layoutOf(page), preset).toEqual(presetLayout(preset));
      if (preset === "cinema") theatreUrl = page.url();
    }
    expect(errors).toEqual([]);

    // On a phone every Theatre seat is tappable: the riser row's 52×44 keys must not cover the row in front (QA OME-1743).
    const phone = await newPage(browser, devices["Pixel 7"]);
    await phone.page.goto(theatreUrl);
    await enter(phone.page, "phone");
    const seats = phone.page.locator(site.seat);
    await expect(seats).toHaveCount(8);
    const hits = await seats.evaluateAll((keys) =>
      keys.map((k) => {
        const r = k.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest<HTMLElement>("[data-seat]")?.dataset["seat"] ?? null;
      }),
    );
    expect(hits).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    expect(phone.errors).toEqual([]);
  });

  test("a link the extension hands over (/#share=) shows in the create form and plays in the new, default (classic) room", async ({ browser }) => {
    const { page, errors } = await newPage(browser);
    const yt = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    await page.goto(`${WEB_URL}/#share=${encodeURIComponent(yt)}`);
    // Dropped from the URL at once (it's a fragment, so it never reached the server either).
    await expect.poll(() => new URL(page.url()).hash).toBe("");
    await openDirectory(page);
    await expect(page.locator(id("share-pending"))).toContainText("This video will play in your new room");
    await page.locator(site.createRoomTitle).fill("Shared");
    await page.locator(site.createRoomSubmit).click();
    await page.waitForURL(/\/r\/[a-z2-7]{26}$/);
    await enter(page);
    await expect.poll(() => roomField(page, "embed")).toMatchObject({ provider: "youtube", videoId: "dQw4w9WgXcQ" });
    expect(await layoutOf(page)).toEqual(presetLayout("classic"));
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("omega.pendingShare.")))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a layout saved from the editor starts a new room, which gets exactly that layout", async ({ browser }) => {
    const { page, errors } = await newPage(browser);
    await createRoom(page, "Edit me", null);
    await page.locator(site.editRoom).click();
    await expect(page.locator(site.editorTray)).toBeVisible();
    // Move the lamp from (9,0) to (8,1), then save the room.
    const hit = page.locator(site.editorHit);
    const click = async (col: number, row: number): Promise<void> => {
      const box = await hit.boundingBox();
      if (box === null) throw new Error("editor hit layer not laid out");
      const p = cellCenter(col, row);
      await hit.click({ position: { x: p.x * (box.width / 960), y: p.y * (box.width / 960) } });
    };
    await click(9, 0);
    await click(8, 1);
    await page.locator(site.editorSave).click();
    await expect.poll(async () => (await layoutOf(page)).furniture.find((f) => f.kind === "lamp")).toMatchObject({ col: 8, row: 1 });
    const changed = await layoutOf(page);
    expect(changed).not.toEqual(presetLayout("classic"));

    await page.locator(id("editor-mine-name")).fill("Lamp moved");
    await page.locator(id("editor-mine-save")).click();
    await expect(page.locator(id("editor-message"))).toContainText('Saved "Lamp moved" to your layouts.');

    // Back home: the layout is listed (text only), and picking it creates an empty room that the owner then fills.
    await page.goto(`${WEB_URL}/`);
    await openDirectory(page);
    const mine = page.locator(id("saved-layouts"));
    await expect(mine).toContainText("Lamp moved");
    await expect(mine.locator("img")).toHaveCount(0);
    await createRoom(page, "From mine", id("saved-layout-radio"));
    await expect.poll(async () => (await layoutOf(page)).furniture.find((f) => f.kind === "lamp")).toMatchObject({ col: 8, row: 1 });
    expect(await layoutOf(page)).toEqual(changed);
    // One layout-set, and the hand-off key is gone.
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("omega.pendingLayout.")))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("garbage in the saved-layouts key: the home page renders and a room can still be created", async ({ browser }) => {
    const { page, errors } = await newPage(browser);
    const badLayout = JSON.stringify([{ name: "Bad", layout: { furniture: [{ kind: "tv", col: 0, row: 0, facing: "se" }] } }]);
    for (const garbage of ["this is not json{", badLayout]) {
      await page.goto(`${WEB_URL}/`);
      await page.evaluate(([key, value]) => {
        localStorage.setItem(key ?? "", value ?? "");
      }, [SAVED_KEY, garbage]);
      await page.reload();
      await openDirectory(page);
      await expect(page.locator(radio("classic"))).toBeChecked();
      await expect(page.locator(id("saved-layouts"))).toHaveCount(0);
    }
    await createRoom(page, "Still works", null);
    expect(await layoutOf(page)).toEqual(presetLayout("classic"));
    expect(errors).toEqual([]);
  });
});
