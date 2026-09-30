import { browser } from "wxt/browser";
import { browserSaveDeps, saveServerBaseUrl } from "../../save-setting";
import { DEFAULT_SERVER_BASE_URL, SERVER_BASE_URL_KEY, readServerBaseUrl } from "../../settings";

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`options: #${id} missing`);
  return el;
}

const form = byId("form", HTMLFormElement);
const input = byId("url", HTMLInputElement);
const status = byId("status", HTMLParagraphElement);
const save = byId("save", HTMLButtonElement);

function show(state: "ok" | "error", message: string): void {
  status.dataset["state"] = state;
  status.textContent = message;
}

// Save stays disabled until the stored origin is known, so its grant is the one revoked on change.
let current = DEFAULT_SERVER_BASE_URL;
save.disabled = true;
void browser.storage.local
  .get(SERVER_BASE_URL_KEY)
  .then((items) => {
    current = readServerBaseUrl(items[SERVER_BASE_URL_KEY]);
    input.value = current;
  })
  .finally(() => {
    save.disabled = false;
  });

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveServerBaseUrl(input.value, current, browserSaveDeps(browser.permissions, browser.storage.local)).then((result) => {
    if (result.ok) {
      current = result.origin;
      input.value = result.origin;
      show("ok", result.message);
    } else {
      show("error", result.message);
    }
  });
});
