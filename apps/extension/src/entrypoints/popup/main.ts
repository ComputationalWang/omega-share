import { DEFAULT_ROOM_ID, type Embed } from "@omega/shared";
import { browser } from "wxt/browser";
import { type ScanOutcome, scanTab } from "../../embeds";
import { collectCandidateUrls } from "../../scan";
import { SERVER_BASE_URL_KEY, readServerBaseUrl } from "../../settings";
import { shareEmbed } from "../../share";

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`popup: #${id} missing`);
  return el;
}

const ui = {
  scanning: byId("scanning", HTMLParagraphElement),
  embeds: byId("embeds", HTMLUListElement),
  empty: byId("empty", HTMLParagraphElement),
  unreadable: byId("unreadable", HTMLParagraphElement),
  form: byId("share-form", HTMLFormElement),
  room: byId("room", HTMLSelectElement),
  share: byId("share", HTMLButtonElement),
  status: byId("status", HTMLParagraphElement),
  options: byId("options", HTMLButtonElement),
};

/** `?tabId=` (used when the popup is opened as a tab, e.g. by e2e), else the active tab. */
async function targetTabId(): Promise<number | undefined> {
  const param = new URLSearchParams(location.search).get("tabId");
  if (param !== null && /^\d{1,10}$/.test(param)) return Number(param);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function scan(): Promise<ScanOutcome> {
  const tabId = await targetTabId();
  if (tabId === undefined) return { kind: "unreadable" };
  return scanTab(() => browser.scripting.executeScript({ target: { tabId }, func: collectCandidateUrls }));
}

function render(outcome: ScanOutcome): void {
  ui.scanning.hidden = true;
  ui.unreadable.hidden = outcome.kind !== "unreadable";
  renderEmbeds(outcome.kind === "embeds" ? outcome.embeds : null);
}

/** `null`: the tab could not be read, so neither the list nor "no video found" applies. */
function renderEmbeds(embeds: readonly Embed[] | null): void {
  if (embeds === null) {
    ui.empty.hidden = true;
    ui.form.hidden = true;
    return;
  }
  ui.empty.hidden = embeds.length > 0;
  ui.form.hidden = embeds.length === 0;
  ui.embeds.replaceChildren(
    ...embeds.map((embed, i) => {
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "embed";
      input.value = embed.url;
      input.checked = i === 0;
      const label = document.createElement("label");
      label.append(input, `YouTube · ${embed.videoId}`);
      const li = document.createElement("li");
      li.dataset["testid"] = "embed-item";
      li.dataset["videoId"] = embed.videoId;
      li.append(label);
      return li;
    }),
  );
}

function renderRooms(rooms: readonly string[]): void {
  ui.room.replaceChildren(...rooms.map((id) => new Option(id, id)));
}

function showStatus(state: "ok" | "error", message: string): void {
  ui.status.hidden = false;
  ui.status.dataset["state"] = state;
  ui.status.textContent = message;
}

const serverBaseUrl = browser.storage.local.get(SERVER_BASE_URL_KEY).then((items) => readServerBaseUrl(items[SERVER_BASE_URL_KEY]));

// Room list: one room until the server serves `GET /rooms` (wired up in OME-20).
renderRooms([DEFAULT_ROOM_ID]);
void scan().then(render);

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const selected = ui.embeds.querySelector<HTMLInputElement>("input[name=embed]:checked");
  if (selected === null) return;
  ui.share.disabled = true;
  ui.status.hidden = true;
  void serverBaseUrl
    .then((baseUrl) => shareEmbed({ baseUrl, roomId: ui.room.value, url: selected.value, fetch: (u, init) => fetch(u, init) }))
    .then((result) => {
      if (result.ok) showStatus("ok", `Shared to ${ui.room.value}.`);
      else showStatus("error", result.message);
    })
    .finally(() => {
      ui.share.disabled = false;
    });
});

ui.options.addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
});
