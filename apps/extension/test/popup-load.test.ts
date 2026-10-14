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
    tabs: { query: () => Promise.resolve([{ id: 1 }]) },
    scripting: { executeScript: () => Promise.reject(new Error("cannot access tab")) },
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

afterEach(() => {
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
