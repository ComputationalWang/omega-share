import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// OME-768 (M9 W2): "Room not found". An unknown, deleted or taken-down room id, or a private room without a working key,
// gets one clear screen: what happened, "Go home", and the open rooms to pick from. Its words never tell a private room
// from no room. Every server string goes in via textContent.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const SERVER = "http://srv.test";
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const LIST = () => json(200, { rooms: [{ id: "lobby", title: "Lobby", memberCount: 3, seatedCount: 1 }, { id: "film-club", title: "Film & club", memberCount: 1, seatedCount: 0 }] });

async function setup(answers: (Response | Error)[] = [LIST()]) {
  const { createNotFound } = await import("../src/not-found");
  const calls: string[] = [];
  const pending = [...answers];
  const nf = createNotFound({
    serverUrl: SERVER,
    fetch: (url) => {
      calls.push(url);
      const a = pending.shift() ?? LIST();
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
  });
  document.body.replaceChildren(nf.root);
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { nf, calls, settle };
}

describe("Room not found", () => {
  test("is hidden and fetches nothing until shown", async () => {
    const { nf, calls } = await setup();
    expect(nf.root.hidden).toBe(true);
    expect(calls).toEqual([]);
  });

  test("says the room doesn't exist or was taken down, with a Go home link", async () => {
    const { nf } = await setup();
    nf.show();
    expect(nf.root.hidden).toBe(false);
    expect(nf.root.querySelector("h2")?.textContent).toBe("This room doesn't exist or was taken down");
    const home = nf.root.querySelector<HTMLAnchorElement>("[data-testid=not-found-home]");
    expect(home?.textContent).toBe("Go home");
    expect(home?.getAttribute("href")).toBe("/");
  });

  test("never says 'private', 'invite' or 'closed by its owner': the words are the same for every way in", async () => {
    const { nf } = await setup();
    nf.show();
    const words = nf.root.textContent.toLowerCase();
    expect(words).not.toContain("this room is private");
    expect(words).not.toContain("owner");
  });

  test("lists the open rooms from GET /rooms once, as text links to /r/<id>", async () => {
    const { nf, calls, settle } = await setup();
    nf.show();
    nf.show();
    await settle();
    expect(calls).toEqual([`${SERVER}/rooms`]);
    const links = [...nf.root.querySelectorAll<HTMLAnchorElement>("[data-testid=not-found-room]")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/r/lobby", "/r/film-club"]);
    expect(links.map((a) => a.textContent)).toEqual(["Lobby", "Film & club"]);
  });

  test("no open rooms: says so instead of an empty list", async () => {
    const { nf, settle } = await setup([json(200, { rooms: [] })]);
    nf.show();
    await settle();
    expect(nf.root.querySelectorAll("[data-testid=not-found-room]").length).toBe(0);
    expect(nf.root.textContent).toMatch(/no open rooms/i);
  });

  test("the list failed to load (offline, or a malformed answer): a Try again key that fetches again", async () => {
    const { nf, calls, settle } = await setup([new Error("offline"), json(200, { nope: 1 }), LIST()]);
    nf.show();
    await settle();
    const retry = nf.root.querySelector<HTMLButtonElement>("[data-testid=not-found-retry]");
    expect(retry?.hidden).toBe(false);
    retry?.click();
    await settle();
    expect(retry?.hidden).toBe(false);
    retry?.click();
    await settle();
    expect(calls.length).toBe(3);
    expect(retry?.hidden).toBe(true);
    expect(nf.root.querySelectorAll("[data-testid=not-found-room]").length).toBe(2);
  });

  test("a room id from the server that isn't a valid id is never made into a link", async () => {
    const { nf, settle } = await setup([json(200, { rooms: [{ id: "../admin", title: "x", memberCount: 1, seatedCount: 0 }] })]);
    nf.show();
    await settle();
    expect(nf.root.querySelector("a[href^='/r/..']")).toBeNull();
  });
});
