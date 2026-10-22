import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { FALLBACK_ROOMS } from "../src/rooms";

// OME-1101: a failed settings read or server load must say so, not leave a silently disabled popup.
const html = readFileSync(new URL("../src/entrypoints/popup/index.html", import.meta.url), "utf8");
const DOM_GLOBALS = ["window", "document", "location", "HTMLElement", "HTMLParagraphElement", "HTMLUListElement", "HTMLFormElement", "HTMLSelectElement", "HTMLButtonElement", "HTMLSpanElement", "HTMLImageElement", "HTMLInputElement"] as const;

interface BrowserStub {
  readonly storageGet: () => Promise<Record<string, unknown>>;
  readonly storageSet?: (items: Record<string, unknown>) => Promise<void>;
  readonly permissionsContains: () => Promise<boolean>;
  readonly tabsQuery?: (query: { readonly url?: readonly string[] }) => Promise<unknown[]>;
  readonly executeScript?: (details: { readonly target: { readonly tabId: number }; readonly args?: readonly unknown[] }) => Promise<unknown[]>;
  readonly calls?: unknown[][];
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
let opened = 0;
let current: BrowserStub | null = null;
const stubbed = (): BrowserStub => {
  if (current === null) throw new Error("no browser stub");
  return current;
};
void mock.module("wxt/browser", () => ({
  browser: {
    storage: { local: { get: () => stubbed().storageGet(), set: (items: Record<string, unknown>) => stubbed().storageSet?.(items) ?? Promise.resolve() } },
    permissions: { contains: () => stubbed().permissionsContains() },
    tabs: {
      query: (query: { readonly url?: readonly string[] }) => stubbed().tabsQuery?.(query) ?? Promise.resolve([{ id: 1 }]),
      update: (...args: unknown[]) => Promise.resolve(stubbed().calls?.push(["tabs.update", ...args])),
      create: (...args: unknown[]) => Promise.resolve(stubbed().calls?.push(["tabs.create", ...args])),
    },
    windows: { update: (...args: unknown[]) => Promise.resolve(stubbed().calls?.push(["windows.update", ...args])) },
    scripting: { executeScript: (details: { readonly target: { readonly tabId: number }; readonly args?: readonly unknown[] }) => stubbed().executeScript?.(details) ?? Promise.reject(new Error("cannot access tab")) },
    runtime: { openOptionsPage: () => Promise.resolve() },
  },
}));

/** Loads a fresh copy of the popup script against happy-dom and a stubbed `browser`, then lets its promises settle. */
async function openPopup(stub: BrowserStub): Promise<Document> {
  const window = new Window({ url: "chrome-extension://test/popup.html", settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  window.document.write(html);
  for (const key of DOM_GLOBALS) Object.assign(globalThis, { [key]: key === "window" ? window : window[key] });
  // happy-dom has no `Option` constructor.
  Object.assign(globalThis, {
    Option: function Option(text: string, value: string, defaultSelected: boolean, selected: boolean) {
      const option = window.document.createElement("option");
      Object.assign(option, { text, value, defaultSelected, selected });
      return option;
    },
  });
  current = stub;
  process.on("unhandledRejection", onUnhandled);
  opened += 1;
  await import(`../src/entrypoints/popup/main.ts?open=${String(opened)}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return window.document as unknown as Document;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
});

function el(document: Document, id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} missing`);
  return found;
}

function expectLoadFailureShown(document: Document): void {
  const status = el(document, "status");
  expect(status.hidden).toBe(false);
  expect(status.dataset["state"]).toBe("error");
  expect(status.textContent).toContain("Close and reopen the popup");
  expect((el(document, "share") as HTMLButtonElement).disabled).toBe(true);
  expect([...(el(document, "room") as HTMLSelectElement).options].map((o) => o.value)).toEqual(FALLBACK_ROOMS.rooms.map((r) => r.id));
  expect(unhandled).toEqual([]);
}

describe("popup load failures", () => {
  test("storage.local.get rejects: the popup says so and the scan still finishes", async () => {
    const document = await openPopup({ storageGet: () => Promise.reject(new Error("storage broken")), permissionsContains: () => Promise.resolve(true) });
    expectLoadFailureShown(document);
    expect(el(document, "scanning").hidden).toBe(true);
  });

  test("loadServer rejects: the popup says so", async () => {
    const document = await openPopup({
      storageGet: () => Promise.resolve({}),
      permissionsContains: () => {
        throw new Error("permissions API missing");
      },
    });
    expectLoadFailureShown(document);
  });
});

// OME-1285: a failed tab query must not leave "Looking for videos…" up forever.
test("tabs.query rejects: the scan ends on the unreadable state", async () => {
  const document = await openPopup({
    storageGet: () => Promise.resolve({}),
    permissionsContains: () => Promise.resolve(true),
    tabsQuery: (query) => (query.url === undefined ? Promise.reject(new Error("no window")) : Promise.resolve([])),
  });
  expect(el(document, "scanning").hidden).toBe(true);
  expect(el(document, "unreadable").hidden).toBe(false);
  expect(unhandled).toEqual([]);
});

// OME-1285: "Shared · Open room" belongs to the last share, not to a newly picked room or embed.
describe("after a successful share", () => {
  const ORIGIN = "http://localhost:8787";
  const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  const TWO_EMBEDS = ["https://www.youtube.com/embed/aqz-KE-bpKQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"];

  /** The popup, loaded. `roomTabs`: the rooms open in site tabs (window 7), each holding its share token. */
  async function opened(stored: Record<string, unknown> = {}, saved: Record<string, unknown>[] = [], roomTabs: readonly string[] = ["lobby"], embeds: readonly string[] = TWO_EMBEDS, calls: unknown[][] = []): Promise<Document> {
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        url.endsWith("/share")
          ? json({ ok: true, embed: { provider: "youtube", videoId: "aqz-KE-bpKQ", url: "https://www.youtube.com/embed/aqz-KE-bpKQ" } })
          : json({ rooms: [{ id: "lobby", memberCount: 1, seatedCount: 0 }, { id: "movies", memberCount: 2, seatedCount: 0 }] }),
      )) as typeof fetch;
    return openPopup({
      calls,
      storageGet: () => Promise.resolve(stored),
      storageSet: (items) => {
        saved.push(items);
        return Promise.resolve();
      },
      permissionsContains: () => Promise.resolve(true),
      tabsQuery: (query) => Promise.resolve(query.url === undefined ? [{ id: 1, url: "https://example.com/" }] : roomTabs.map((id, i) => ({ id: i + 2, windowId: 7, url: `${ORIGIN}/r/${id}` }))),
      executeScript: ({ target, args }) =>
        Promise.resolve([
          {
            result:
              args === undefined
                ? { urls: ["https://example.com/", ...embeds], media: [], frames: [] }
                : JSON.stringify({ roomId: roomTabs[target.tabId - 2], token: TOKEN }),
          },
        ]),
    });
  }

  async function shared(stored: Record<string, unknown> = {}, saved: Record<string, unknown>[] = [], roomTabs: readonly string[] = ["lobby"], calls: unknown[][] = []): Promise<Document> {
    const document = await opened(stored, saved, roomTabs, TWO_EMBEDS, calls);
    (el(document, "room") as HTMLSelectElement).value = "lobby";
    (el(document, "share-form") as HTMLFormElement).requestSubmit(el(document, "share"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(el(document, "status").textContent).toBe("Shared · Open room");
    expect(el(document, "status").hidden).toBe(false);
    return document;
  }

  async function openRoom(document: Document): Promise<void> {
    const button = [...document.querySelectorAll<HTMLButtonElement>("#status button")].find((b) => b.textContent === "Open room");
    if (button === undefined) throw new Error("no Open room button");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // OME-1635 E2: land in the room.
  test("Open room focuses the open room tab and its window", async () => {
    const calls: unknown[][] = [];
    await openRoom(await shared({}, [], ["movies", "lobby"], calls));
    expect(calls).toEqual([
      ["tabs.update", 3, { active: true }],
      ["windows.update", 7, { focused: true }],
    ]);
  });

  test("Open room opens the room in a new tab when no tab has it", async () => {
    const calls: unknown[][] = [];
    const document = await shared({}, [], ["lobby"], calls);
    // The room tab was closed after the share.
    current = { ...stubbed(), tabsQuery: () => Promise.resolve([]) };
    await openRoom(document);
    expect(calls).toEqual([["tabs.create", { url: `${ORIGIN}/r/lobby` }]]);
  });

  // OME-1636: the share starts where the page is.
  test("Share sends the listed embed's start", async () => {
    const document = await opened({}, [], ["lobby"], ["https://www.youtube.com/embed/aqz-KE-bpKQ?start=75"]);
    const bodies: unknown[] = [];
    const loaded = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      if (url.endsWith("/share")) bodies.push(JSON.parse(typeof init.body === "string" ? init.body : ""));
      return loaded(url, init);
    }) as typeof fetch;
    (el(document, "room") as HTMLSelectElement).value = "lobby";
    (el(document, "share-form") as HTMLFormElement).requestSubmit(el(document, "share"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bodies).toEqual([{ url: "https://www.youtube.com/embed/aqz-KE-bpKQ", startSeconds: 75 }]);
  });

  // OME-1635 E1: one embed and the remembered room preselected, so Enter or one click shares.
  test("one embed and a remembered room: Share has focus", async () => {
    const document = await opened({ lastRoom: "lobby" }, [], ["lobby"], ["https://www.youtube.com/embed/aqz-KE-bpKQ"]);
    expect((el(document, "room") as HTMLSelectElement).value).toBe("lobby");
    expect(document.activeElement?.id).toBe("share");
  });

  test("two embeds: the first embed has focus, so the user picks", async () => {
    const document = await opened({ lastRoom: "lobby" });
    expect(document.activeElement?.getAttribute("name")).toBe("embed");
  });

  test("no remembered room: the embed has focus, so the user checks the room", async () => {
    const document = await opened({}, [], ["lobby"], ["https://www.youtube.com/embed/aqz-KE-bpKQ"]);
    expect(document.activeElement?.getAttribute("name")).toBe("embed");
  });

  test("the room is remembered and preselected next time while it's listed", async () => {
    const saved: Record<string, unknown>[] = [];
    await shared({}, saved);
    expect(saved).toEqual([{ lastRoom: "lobby" }]);
    const reopened = await shared({ lastRoom: "movies" }, [], ["lobby", "movies"]);
    expect([...(el(reopened, "room") as HTMLSelectElement).options].find((o) => o.defaultSelected)?.value).toBe("movies");
  });

  // e2e provider-share (PR #330): the room tab moved on to another room, so the last room has no token any more.
  test("a remembered room without a share token gives way to the room tab that has one", async () => {
    const document = await shared({ lastRoom: "movies" });
    expect([...(el(document, "room") as HTMLSelectElement).options].find((o) => o.defaultSelected)?.value).toBe("lobby");
  });

  test("a remembered room that's gone is ignored", async () => {
    const document = await shared({ lastRoom: "gone" });
    expect([...(el(document, "room") as HTMLSelectElement).options].find((o) => o.defaultSelected)?.value).toBe("lobby");
  });

  test("picking another room clears the status", async () => {
    const document = await shared();
    const room = el(document, "room") as HTMLSelectElement;
    room.value = "movies";
    room.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(el(document, "status").textContent).toBe("");
  });

  test("picking another embed clears the status", async () => {
    const document = await shared();
    const radios = [...document.querySelectorAll<HTMLInputElement>("input[name=embed]")];
    expect(radios.length).toBe(2);
    const other = radios[1];
    if (other === undefined) throw new Error("no second embed");
    other.checked = true;
    other.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(el(document, "status").textContent).toBe("");
  });
});
