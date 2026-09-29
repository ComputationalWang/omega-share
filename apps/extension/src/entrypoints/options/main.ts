import { browser } from "wxt/browser";
import { DEFAULT_SERVER_BASE_URL, SERVER_BASE_URL_KEY, hostPermissionPattern, parseServerBaseUrl, readServerBaseUrl } from "../../settings";

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`options: #${id} missing`);
  return el;
}

const form = byId("form", HTMLFormElement);
const input = byId("url", HTMLInputElement);
const status = byId("status", HTMLParagraphElement);

function show(state: "ok" | "error", message: string): void {
  status.dataset["state"] = state;
  status.textContent = message;
}

let current = DEFAULT_SERVER_BASE_URL;
void browser.storage.local.get(SERVER_BASE_URL_KEY).then((items) => {
  current = readServerBaseUrl(items[SERVER_BASE_URL_KEY]);
  input.value = current;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const parsed = parseServerBaseUrl(input.value);
  if (!parsed.ok) {
    show("error", parsed.message);
    return;
  }
  const { origin } = parsed;
  const previous = current;
  // Request inside the click's user gesture. The default origin is already granted by the manifest.
  const granted = origin === DEFAULT_SERVER_BASE_URL ? Promise.resolve(true) : browser.permissions.request({ origins: [hostPermissionPattern(origin)] });
  void granted.then(async (ok) => {
    if (!ok) {
      show("error", `Permission to reach ${origin} was not granted.`);
      return;
    }
    await browser.storage.local.set({ [SERVER_BASE_URL_KEY]: origin });
    current = origin;
    input.value = origin;
    if (previous !== origin && previous !== DEFAULT_SERVER_BASE_URL) {
      await browser.permissions.remove({ origins: [hostPermissionPattern(previous)] });
    }
    show("ok", `Saved. Sharing to ${origin}.`);
  });
});
