import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

// OME-1298: the options page explains a refused found toggle and ties its hint and errors to the URL field.
const html = readFileSync(new URL("../src/entrypoints/options/index.html", import.meta.url), "utf8");
const DOM_GLOBALS = ["window", "document", "location", "HTMLElement", "HTMLFormElement", "HTMLInputElement", "HTMLParagraphElement", "HTMLButtonElement"] as const;

interface BrowserStub {
  readonly request?: () => Promise<boolean>;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
let opened = 0;
let current: BrowserStub = {};
let stored: Record<string, unknown> = {};
let foundGranted = false;
void mock.module("wxt/browser", () => ({
  browser: {
    permissions: {
      contains: () => Promise.resolve(foundGranted),
      request: () => current.request?.() ?? Promise.resolve(true),
      remove: () => Promise.resolve(true),
    },
    storage: {
      local: {
        get: () => Promise.resolve(stored),
        set: (items: Record<string, unknown>) => {
          stored = { ...stored, ...items };
          return Promise.resolve();
        },
      },
    },
  },
}));

/** Loads a fresh copy of the options script against happy-dom and a stubbed `browser`, then lets its promises settle. */
async function openOptions(stub: BrowserStub = {}): Promise<Document> {
  const window = new Window({ url: "chrome-extension://test/options.html", settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  window.document.write(html);
  for (const key of DOM_GLOBALS) Object.assign(globalThis, { [key]: key === "window" ? window : window[key] });
  current = stub;
  stored = {};
  foundGranted = false;
  process.on("unhandledRejection", onUnhandled);
  opened += 1;
  await import(`../src/entrypoints/options/main.ts?open=${String(opened)}`);
  await settle();
  return window.document as unknown as Document;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
});

function el(document: Document, testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`${testId} missing`);
  return found;
}

function submit(document: Document, value: string): void {
  const input = (el(document, "server-url-input") as HTMLInputElement);
  input.value = value;
  (el(document, "server-url-save") as HTMLButtonElement).click();
}

test("a refused found-toggle request leaves the box unchecked and says why", async () => {
  const document = await openOptions({ request: () => Promise.resolve(false) });
  const toggle = (el(document, "found-toggle") as HTMLInputElement);
  toggle.click();
  await settle();
  expect(toggle.checked).toBe(false);
  expect(el(document, "found-status").getAttribute("role")).toBe("status");
  expect(el(document, "found-status").textContent).toContain("not granted");
  expect(unhandled).toEqual([]);
});

test("the page has a main landmark and an h1", async () => {
  const document = await openOptions();
  expect(document.querySelector("main")).not.toBeNull();
  expect(document.querySelector("h1")?.textContent).toBeTruthy();
});

test("the URL field is described by its hint", async () => {
  const document = await openOptions();
  const describedBy = el(document, "server-url-input").getAttribute("aria-describedby") ?? "";
  const hint = document.getElementById(describedBy.split(/\s+/)[0] ?? "");
  expect(hint?.textContent).toContain("with no path");
});

test("a validation error marks the field invalid; a good save clears it", async () => {
  const document = await openOptions();
  const input = (el(document, "server-url-input") as HTMLInputElement);
  submit(document, "ftp://example.com");
  await settle();
  expect(el(document, "server-url-status").dataset["state"]).toBe("error");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  submit(document, "http://localhost:8787");
  await settle();
  expect(el(document, "server-url-status").dataset["state"]).toBe("ok");
  expect(input.getAttribute("aria-invalid")).not.toBe("true");
});

test("editing the field clears the Saved status", async () => {
  const document = await openOptions();
  const input = (el(document, "server-url-input") as HTMLInputElement);
  submit(document, "http://localhost:8787");
  await settle();
  expect(el(document, "server-url-status").textContent).not.toBe("");
  input.value = "http://localhost:878";
  input.dispatchEvent(new window.Event("input"));
  expect(el(document, "server-url-status").textContent).toBe("");
});
