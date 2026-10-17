import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

// OME-1298: the consent page never fails silently and always offers a way out.
const html = readFileSync(new URL("../src/entrypoints/consent/index.html", import.meta.url), "utf8");
const DOM_GLOBALS = ["window", "document", "location", "HTMLElement"] as const;

interface BrowserStub {
  readonly request?: () => Promise<boolean>;
  readonly storageSet?: () => Promise<void>;
  readonly sendMessage?: () => Promise<unknown>;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
let opened = 0;
let current: BrowserStub = {};
void mock.module("wxt/browser", () => ({
  browser: {
    permissions: { request: () => current.request?.() ?? Promise.resolve(true) },
    storage: { local: { get: () => Promise.resolve({}), set: () => current.storageSet?.() ?? Promise.resolve() } },
    runtime: { sendMessage: () => current.sendMessage?.() ?? Promise.resolve(undefined) },
  },
}));

interface Page {
  readonly document: Document;
  readonly closed: () => number;
}

/** Loads a fresh copy of the consent script against happy-dom and a stubbed `browser`. */
async function openConsent(search: string, stub: BrowserStub = {}): Promise<Page> {
  const window = new Window({ url: `chrome-extension://test/consent.html${search}`, settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  window.document.write(html);
  let closes = 0;
  window.close = () => {
    closes += 1;
  };
  for (const key of DOM_GLOBALS) Object.assign(globalThis, { [key]: key === "window" ? window : window[key] });
  current = stub;
  process.on("unhandledRejection", onUnhandled);
  opened += 1;
  await import(`../src/entrypoints/consent/main.ts?open=${String(opened)}`);
  return { document: window.document as unknown as Document, closed: () => closes };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
});

function el(document: Document, id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} missing`);
  return found;
}

function statusOf(document: Document): HTMLElement {
  const status = document.querySelector<HTMLElement>('[role="status"]');
  if (status === null) throw new Error("no status region");
  return status;
}

const GOOD = "?host=example.com&tabId=7";

describe("consent page answers that fail", () => {
  const failures: [string, string, BrowserStub][] = [
    ["Allow", "allow", { storageSet: () => Promise.reject(new Error("quota")) }],
    ["Allow", "allow", { sendMessage: () => Promise.reject(new Error("no receiver")) }],
    ["Not now", "deny", { sendMessage: () => Promise.reject(new Error("no receiver")) }],
  ];
  test.each(failures)("%s with a rejecting browser call shows an error and keeps the buttons", async (_name, id, stub) => {
    const { document, closed } = await openConsent(GOOD, stub);
    el(document, id).click();
    await settle();
    expect(statusOf(document).textContent).toContain("Try again");
    expect(statusOf(document).hidden).toBe(false);
    for (const button of ["allow", "deny"]) {
      expect(el(document, button).hidden).toBe(false);
      expect((el(document, button) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(closed()).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

test("a denied permission keeps the window open and says so", async () => {
  const { document, closed } = await openConsent(GOOD, { request: () => Promise.resolve(false) });
  el(document, "allow").click();
  await settle();
  expect(statusOf(document).textContent).toContain("didn't allow");
  expect(closed()).toBe(0);
  expect(unhandled).toEqual([]);
});

test("a granted permission closes the window", async () => {
  const { document, closed } = await openConsent(GOOD);
  el(document, "allow").click();
  await settle();
  expect(closed()).toBe(1);
});

test("a bad host param offers a visible Close button that closes the window", async () => {
  const { document, closed } = await openConsent("?host=not%20a%20host&tabId=7");
  expect(el(document, "title").textContent).toBe("Nothing to unlock here.");
  const close = el(document, "close");
  expect(close.hidden).toBe(false);
  close.click();
  expect(closed()).toBe(1);
});
