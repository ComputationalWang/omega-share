// Screen-reader room presence (OME-1246, QA research OME-1243 S1–S4): joins are said in the chat log once, the TV has
// a non-live "now playing" text that follows the room's state, the stage canvas is out of the accessibility tree, and
// a playback line reaches exactly one live region (the chat log; the caption rail is visual only).
import type { BrowserContext } from "@playwright/test";
import * as v from "valibot";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { shareVideo, waitPlaying } from "../perf/sync";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const one = (cs: readonly Client[]): Client => {
  const [c] = cs;
  if (c === undefined || cs.length !== 1) throw new Error("need one client");
  return c;
};

test("B joining is one line in A's log; not in B's own, and not again when B resumes", async ({ browser }) => {
  const room = testRoom("a11y-presence", "join");
  const a = one(await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "pa" }));
  clients.push(a);
  const b = one(await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "pb" }));
  clients.push(b);
  const joinedLines = (c: Client) => c.page.locator(site.chatLog).locator(site.chatLogLine).filter({ hasText: "joined the room" });
  await expect(joinedLines(a)).toHaveText(["pb-1 joined the room"]);
  await expect(a.page.getByRole("log")).toContainText("pb-1 joined the room");
  await expect(joinedLines(b)).toHaveCount(0);

  // A reload resumes inside the grace window (ADR 0043): the same member, so nothing new is said.
  await b.page.reload();
  await expect(b.page.locator(site.room)).toBeVisible();
  await expect(b.page.locator(site.nicknameInput)).toBeHidden();
  await expect.poll(async () => (await a.page.locator(site.nicknameTag).allInnerTexts()).sort()).toEqual(["pa-1", "pb-1"]);
  await a.page.waitForTimeout(1000);
  await expect(joinedLines(a)).toHaveCount(1);
  await expect(joinedLines(b)).toHaveCount(0);
});

const AxNode = v.object({
  ignored: v.optional(v.boolean()),
  role: v.optional(v.object({ value: v.unknown() })),
  name: v.optional(v.object({ value: v.unknown() })),
});
const AxTree = v.object({ nodes: v.array(AxNode) });

async function unnamedCanvases(context: BrowserContext, c: Client): Promise<number> {
  const cdp = await context.newCDPSession(c.page);
  await cdp.send("Accessibility.enable");
  const tree = v.parse(AxTree, await cdp.send("Accessibility.getFullAXTree"));
  return tree.nodes.filter((n) => n.ignored !== true && n.role?.value === "Canvas" && (typeof n.name?.value !== "string" || n.name.value === "")).length;
}

/** Live regions (aria-live, or a role that implies it) whose text holds `text`, outside anything aria-hidden. */
const liveRegionsSaying = (c: Client, text: string) =>
  c.page.evaluate((t) => {
    const live = document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="log"], [role="status"], [role="alert"]');
    return [...live].filter((e) => e.closest('[aria-hidden="true"]') === null && e.textContent.includes(t)).length;
  }, text);

test("now playing near the TV follows the state; the canvas is out of the AX tree; a playback line is in one live region", async ({ browser, request }) => {
  const room = testRoom("a11y-presence", "tv");
  await shareVideo(request, room.id);
  const a = one(await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "pt" }));
  clients.push(a);
  await waitPlaying([a]);

  await expect(a.page.getByText("YouTube video, playing", { exact: true })).toBeAttached();
  await a.page.locator(site.playToggle).click();
  await a.page.locator(site.seek).fill("83");
  await expect(a.page.getByText("YouTube video, paused at 1:23", { exact: true })).toBeAttached();
  const nowPlaying = a.page.getByText("YouTube video, paused at 1:23", { exact: true });
  expect(await nowPlaying.evaluate((e) => e.closest('[aria-live], [role="log"], [role="status"], [role="alert"]') === null)).toBe(true);

  await expect(a.page.locator(site.chatLog)).toContainText("You paused");
  expect(await liveRegionsSaying(a, "You paused")).toBe(1);
  expect(await liveRegionsSaying(a, "You skipped to")).toBe(1);

  await expect(a.page.locator("canvas.scene")).toHaveAttribute("aria-hidden", "true");
  expect(await unnamedCanvases(a.context, a)).toBe(0);
});
