// OME-417: the owner's layout editor against the frame budgets (ADR 0009/0017): frame rows with the owner's layout editor open (8 avatars + video), and a guest's frames across a layout save.
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { joinRoom, leaveAll, type Client } from "../e2e/support/room";
import { stubExternalNetwork } from "../e2e/support/network";
import { watchCsp } from "../e2e/support/csp";
import { site } from "../e2e/support/selectors";
import { cellCenter } from "../apps/web/src/layout";
import { VSYNC_MS, frameTimes, tracedFrames } from "./frames";
import { RESULTS_DIR, p95 } from "./metrics";
import { summarizeFrames } from "./spread";
import { PLAYING, fakeState, shareVideo, waitPlaying } from "./sync";

async function clickCell(page: Page, col: number, row: number): Promise<void> {
  const hit = page.locator(site.editorHit);
  const box = await hit.boundingBox();
  if (box === null) throw new Error("editor hit layer not laid out");
  const p = cellCenter(col, row);
  const scale = box.width / 960;
  await hit.click({ position: { x: p.x * scale, y: p.y * scale } });
}

const out: Record<string, unknown> = {};
const row = (samples: number[], work?: number[]) => {
  const f = summarizeFrames(samples, VSYNC_MS);
  return { p95: f.p95, missedPct: f.missedPct, missed: f.missed, frames: f.frames, maxMs: Math.max(...samples), rawP95: p95(samples), ...(work ? { workP95: p95(work), workMax: Math.max(...work), traced: work.length } : {}) };
};

test("editor: owner frames with the editor open, guest frames across a save", async ({ browser, request }) => {
  test.skip(!available.web || !available.server, available.web ? PENDING.server : PENDING.web);
  test.setTimeout(180_000);
  const ctx = await watchCsp(await browser.newContext());
  await stubExternalNetwork(ctx);
  const owner = await ctx.newPage();
  const chunks: string[] = [];
  owner.on("response", async (r) => { if (/\/assets\/editor-[\w-]+\.js$/.test(r.url())) chunks.push(`${r.url()} ${String((await r.body()).length)} B raw`); });
  await owner.goto(`${URLS.web}/`);
  await owner.locator(site.createRoomTitle).fill("Perf editor");
  await owner.locator(site.createRoomSubmit).click();
  await owner.waitForURL(/\/r\/[a-z2-7]{26}$/);
  const id = owner.url().split("/").pop() ?? "";
  await owner.locator(site.nicknameInput).fill("owner");
  await owner.locator(site.joinButton).click();
  await expect(owner.locator(site.room)).toBeVisible();
  await shareVideo(request, id);
  const guests = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${id}`, count: 7, nicknamePrefix: "ed" });
  const all: Client[] = [{ context: ctx, page: owner, nickname: "owner", avatarIndex: 0 }, ...guests];
  try {
    await waitPlaying(all);
    // Baseline: owner, editor closed.
    out["ownerClosed"] = (({ samples, workMs }) => row(samples, workMs))(await tracedFrames(browser, owner, 5000));
    await owner.locator(site.editRoom).click();
    await expect(owner.locator(site.editorTray)).toBeVisible();
    await owner.waitForTimeout(1000);
    out["ownerEditorOpen"] = (({ samples, workMs }) => row(samples, workMs))(await tracedFrames(browser, owner, 5000));
    expect(await fakeState(owner)).toBe(PLAYING);
    // Owner frames while editing (moves + placing).
    const editing = frameTimes(owner, 4000);
    await clickCell(owner, 9, 0);
    await clickCell(owner, 8, 1);
    await owner.locator(site.editorTab).filter({ hasText: "Decor" }).click();
    await owner.locator(`${site.editorSlot}[data-kind="popcorn"]`).click();
    await clickCell(owner, 9, 9);
    out["ownerEditing"] = row(await editing);
    // A guest across the save (layout-changed → one static rebuild).
    const [g] = guests;
    if (!g) throw new Error("no guest");
    const across = frameTimes(g.page, 4000);
    await g.page.waitForTimeout(1000);
    await owner.locator(site.editorSave).click();
    out["guestAcrossSave"] = row(await across);
    await expect(owner.getByText("Saved.")).toBeVisible({ timeout: 5000 });
    out["saveLanded"] = true;
    out["guestAfter"] = (({ samples, workMs }) => row(samples, workMs))(await tracedFrames(browser, g.page, 5000));
    out["editorChunk"] = chunks;
    // Same budgets as the frame rows: quantised p95 ≤ one vsync, ≤ 1 % missed, ≤ 8 ms main-thread work p95.
    for (const [k, r] of Object.entries(out)) {
      if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
      expect(Reflect.get(r, "p95"), k).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
      expect(Reflect.get(r, "missedPct"), k).toBeLessThanOrEqual(1);
      const work: unknown = Reflect.get(r, "workP95");
      if (typeof work === "number") expect(work, k).toBeLessThanOrEqual(8);
    }
  } finally {
    writeFileSync(join(RESULTS_DIR, "editor.json"), JSON.stringify(out, null, 2));
    await leaveAll(guests);
    await ctx.close();
  }
});
