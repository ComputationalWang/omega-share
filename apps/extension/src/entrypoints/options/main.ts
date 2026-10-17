import { browser } from "wxt/browser";
import { FOUND_ORIGINS } from "../../found";
import { browserSaveDeps, saveServerBaseUrl } from "../../save-setting";
import { SERVER_BASE_URL_KEY, parseServerBaseUrl, readServerBaseUrl } from "../../settings";

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

input.addEventListener("input", () => {
  status.textContent = "";
  input.removeAttribute("aria-invalid");
});

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
      input.removeAttribute("aria-invalid");
      show("ok", result.message);
    } else {
      // Only a malformed URL is the field's fault; a refused permission isn't.
      if (!parseServerBaseUrl(input.value).ok) input.setAttribute("aria-invalid", "true");
      show("error", result.message);
    }
  });
});

// OME-1042: the opt-in found indicator is the optional https://*/* grant itself; the background reacts to the change.
const found = byId("found", HTMLInputElement);
const foundStatus = byId("found-status", HTMLParagraphElement);
const foundOrigins = { origins: [...FOUND_ORIGINS] };
void browser.permissions.contains(foundOrigins).then((granted) => {
  found.checked = granted;
  found.disabled = false;
});
found.addEventListener("change", () => {
  // permissions.request needs this click's user gesture, so nothing is awaited before it.
  const wanted = found.checked;
  foundStatus.textContent = "";
  const change = wanted ? browser.permissions.request(foundOrigins) : browser.permissions.remove(foundOrigins);
  void change.catch(() => false).then(() => browser.permissions.contains(foundOrigins)).then((granted) => {
    found.checked = granted;
    if (wanted && !granted) foundStatus.textContent = "Permission to read https sites was not granted, so the indicator stays off.";
  });
});
