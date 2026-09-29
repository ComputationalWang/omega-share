import { browser } from "wxt/browser";
import { saveServerBaseUrl } from "../../save-setting";
import { DEFAULT_SERVER_BASE_URL, SERVER_BASE_URL_KEY, readServerBaseUrl } from "../../settings";

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
  void saveServerBaseUrl(input.value, current, {
    requestOrigin: (pattern) => browser.permissions.request({ origins: [pattern] }),
    store: (origin) => browser.storage.local.set({ [SERVER_BASE_URL_KEY]: origin }),
    removeOrigin: (pattern) => browser.permissions.remove({ origins: [pattern] }),
  }).then((result) => {
    if (result.ok) {
      current = result.origin;
      input.value = result.origin;
      show("ok", result.message);
    } else {
      show("error", result.message);
    }
  });
});
