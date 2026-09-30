import { browser } from "wxt/browser";
import { browserSaveDeps, saveServerBaseUrl } from "../../save-setting";
import { SERVER_BASE_URL_KEY, readServerBaseUrl } from "../../settings";

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

// Save stays disabled until the stored origin is shown, so the user edits what is actually saved.
save.disabled = true;
void browser.storage.local
  .get(SERVER_BASE_URL_KEY)
  .then((items) => {
    input.value = readServerBaseUrl(items[SERVER_BASE_URL_KEY]);
  })
  .finally(() => {
    save.disabled = false;
  });

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveServerBaseUrl(input.value, browserSaveDeps(browser.permissions, browser.storage.local)).then((result) => {
    if (result.ok) {
      input.value = result.origin;
      show("ok", result.message);
    } else {
      show("error", result.message);
    }
  });
});
