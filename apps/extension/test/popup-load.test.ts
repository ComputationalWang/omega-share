import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { FALLBACK_ROOMS } from "../src/rooms";

// OME-1101: a failed settings read or server load must say so, not leave a silently disabled popup.
const html = readFileSync(new URL("../src/entrypoints/popup/index.html", import.meta.url), "utf8");
const DOM_GLOBALS = ["window", "document", "location", "HTMLElement", "HTMLParagraphElement", "HTMLUListElement", "HTMLFormElement", "HTMLSelectElement", "HTMLButtonElement", "HTMLSpanElement", "HTMLImageElement", "HTMLInputElement"] as const;

interface BrowserStub {
  readonly storageGet: () => Promise<Record<string, unknown>>;
  readonly permissionsContains: () => Promise<boolean>;
  readonly tabsQuery?: (query: { readonly url?: readonly string[] }) => Promise<unknown[]>;
  readonly executeScript?: (details: { readonly args?: readonly unknown[] }) => Promise<unknown[]>;
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
    storage: { local: { get: () => stubbed().storageGet() } },
    permissions: { contains: () => stubbed().permissionsContains() },
    tabs: { query: (query: { readonly url?: readonly string[] }) => stubbed().tabsQuery?.(query) ?? Promise.resolve([{ id: 1 }]) },
    scripting: { executeScript: (details: { readonly args?: readonly unknown[] }) => stubbed().executeScript?.(details) ?? Promise.reject(new Error("cannot access tab")) },
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

// OME-1285: "Shared to X" belongs to the last share, not to a newly picked room or embed.
describe("after a successful share", () => {
  const ORIGIN = "http://localhost:8787";
  const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  async function shared(): Promise<Document> {
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        url.endsWith("/share")
          ? json({ ok: true, embed: { provider: "youtube", videoId: "aqz-KE-bpKQ", url: "https://www.youtube.com/embed/aqz-KE-bpKQ" } })
          : json({ rooms: [{ id: "lobby", memberCount: 1, seatedCount: 0 }, { id: "movies", memberCount: 2, seatedCount: 0 }] }),
      )) as typeof fetch;
    const document = await openPopup({
      storageGet: () => Promise.resolve({}),
      permissionsContains: () => Promise.resolve(true),
      tabsQuery: (query) => Promise.resolve(query.url === undefined ? [{ id: 1, url: "https://example.com/" }] : [{ id: 2, url: `${ORIGIN}/r/lobby` }]),
      executeScript: ({ args }) =>
        Promise.resolve([
          {
            result:
              args === undefined
                ? { urls: ["https://example.com/", "https://www.youtube.com/embed/aqz-KE-bpKQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"], media: [], frames: [] }
                : JSON.stringify({ roomId: "lobby", token: TOKEN }),
          },
        ]),
    });
    (el(document, "share-form") as HTMLFormElement).requestSubmit(el(document, "share") as HTMLButtonElement);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(el(document, "status").textContent).toContain("Shared to lobby.");
    expect(el(document, "status").hidden).toBe(false);
    return document;
  }

  test("picking another room clears the status", async () => {
    const document = await shared();
    const room = el(document, "room") as HTMLSelectElement;
    room.value = "movies";
    room.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(el(document, "status").hidden).toBe(true);
  });

  test("picking another embed clears the status", async () => {
    const document = await shared();
    const radios = [...document.querySelectorAll<HTMLInputElement>("input[name=embed]")];
    expect(radios.length).toBe(2);
    const other = radios[1];
    if (other === undefined) throw new Error("no second embed");
    other.checked = true;
    other.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(el(document, "status").hidden).toBe(true);
  });
});
