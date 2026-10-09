// OME-507: the owner's moderation menu against the frame budgets (ADR 0009/0017, M6 plan "rerun with the moderation menu
// open"): owner frames with the menu closed and open over a guest's tag (8 avatars + video), plus the setting on screen.
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { joinRoom, leaveAll, type Client } from "../e2e/support/room";
import { stubExternalNetwork } from "../e2e/support/network";
import { watchCsp } from "../e2e/support/csp";
import { site } from "../e2e/support/selectors";
import { VSYNC_MS, tracedFrames } from "./frames";
import { RESULTS_DIR, p95 } from "./metrics";
import { summarizeFrames } from "./spread";
import { PLAYING, fakeState, shareVideo, waitPlaying } from "./sync";

const out: Record<string, unknown> = {};
const row = ({ samples, workMs }: { samples: number[]; workMs: number[] }) => {
  const f = summarizeFrames(samples, VSYNC_MS);
  return { p95: f.p95, missedPct: f.missedPct, missed: f.missed, frames: f.frames, maxMs: Math.max(...samples), rawP95: p95(samples), workP95: p95(workMs), workMax: Math.max(...workMs), traced: workMs.length };
};

test("moderation: owner frames with the member menu open (8 avatars + video)", async ({ browser, request }) => {
  test.skip(!available.web || !available.server, available.web ? PENDING.server : PENDING.web);
  test.setTimeout(180_000);
  const ctx = await watchCsp(await browser.newContext());
  await stubExternalNetwork(ctx);
  const owner = await ctx.newPage();
  const chunks: string[] = [];
  owner.on("response", async (r) => { if (/\/assets\/moderation-[\w-]+\.js$/.test(r.url())) chunks.push(`${r.url()} ${String((await r.body()).length)} B raw`); });
  await owner.goto(`${URLS.web}/`);
  await owner.locator(site.createRoomTitle).fill("Perf moderation");
  await owner.locator(site.createRoomSubmit).click();
  await owner.waitForURL(/\/r\/[a-z2-7]{26}$/);
  const id = owner.url().split("/").pop() ?? "";
  await owner.locator(site.nicknameInput).fill("owner");
  await owner.locator(site.joinButton).click();
  await expect(owner.locator(site.room)).toBeVisible();
  await shareVideo(request, id);
  const guests = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${id}`, count: 7, nicknamePrefix: "md" });
  const all: Client[] = [{ context: ctx, page: owner, nickname: "owner", avatarIndex: 0 }, ...guests];
  try {
    await waitPlaying(all);
    await expect(owner.locator(site.controlPolicy)).toBeVisible();
    out["ownerMenuClosed"] = row(await tracedFrames(browser, owner, 5000));
    const [g] = guests;
    if (!g) throw new Error("no guest");
    await owner.locator(site.nicknameTag).filter({ hasText: g.nickname }).click();
    await expect(owner.locator(site.modMenu)).toBeVisible();
    await owner.waitForTimeout(1000);
    out["ownerMenuOpen"] = row(await tracedFrames(browser, owner, 5000));
    expect(await fakeState(owner)).toBe(PLAYING);
    // Remove asks first: the ask row is on screen too.
    await owner.locator(`${site.modRemove} button`).click();
    await expect(owner.locator(site.modConfirm)).toBeVisible();
    out["ownerMenuAsking"] = row(await tracedFrames(browser, owner, 5000));
    out["moderationChunk"] = chunks;
    // Same budgets as the frame rows: quantised p95 ≤ one vsync, ≤ 1 % missed, ≤ 8 ms main-thread work p95.
    for (const [k, r] of Object.entries(out)) {
      if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
      expect(Reflect.get(r, "p95"), k).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
      expect(Reflect.get(r, "missedPct"), k).toBeLessThanOrEqual(1);
      expect(Reflect.get(r, "workP95"), k).toBeLessThanOrEqual(8);
    }
  } finally {
    writeFileSync(join(RESULTS_DIR, "moderation.json"), JSON.stringify(out, null, 2));
    await leaveAll(guests);
    await ctx.close();
  }
});
