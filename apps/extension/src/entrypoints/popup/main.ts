import { type Embed, SHARE_TOKEN_STORAGE_KEY } from "@omega/shared";
import { browser } from "wxt/browser";
import { type ScanOutcome, scanTab } from "../../embeds";
import { FALLBACK_ROOMS, type RoomList, type RoomsProbe, loadRooms } from "../../rooms";
import { collectCandidateUrls } from "../../scan";
import { serverStatus } from "../../server-status";
import { SERVER_BASE_URL_KEY, hostPermissionPattern, readServerBaseUrl } from "../../settings";
import { shareEmbed } from "../../share";
import { MAX_RECORD_LENGTH, readRecordInPage, readShareTokens } from "../../share-token";

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
  server: byId("server-status", HTMLParagraphElement),
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

function renderRooms({ rooms, selected }: RoomList): void {
  ui.room.replaceChildren(...rooms.map((r) => new Option(r.label, r.id, r.id === selected, r.id === selected)));
}

function showStatus(state: "ok" | "error", message: string): void {
  ui.status.hidden = false;
  ui.status.dataset["state"] = state;
  ui.status.textContent = message;
}

interface ServerState {
  readonly origin: string;
  readonly permitted: boolean;
  readonly probe: RoomsProbe;
  readonly tokens: ReadonlyMap<string, string>;
}

/** Share stays off until the server state is known, then follows the §5.4 table for the selected room. */
let server: ServerState | null = null;

function renderServer(): void {
  const status = server === null ? null : serverStatus({ ...server, hasToken: server.tokens.has(ui.room.value) });
  ui.share.disabled = status?.canShare !== true;
  ui.server.hidden = status?.message === null || status === null;
  ui.server.textContent = status?.message ?? "";
  ui.options.dataset["emphasis"] = String(status?.openOptions === true);
}

/** The listed rooms, plus any room we hold a token for; the first token's room is pre-selected. */
function roomsWithTokens(list: RoomList, tokens: ReadonlyMap<string, string>): RoomList {
  const [first] = tokens.keys();
  if (first === undefined) return list;
  const extra = [...tokens.keys()].filter((id) => !list.rooms.some((r) => r.id === id)).map((id) => ({ id, label: id }));
  return { rooms: [...list.rooms, ...extra], selected: first };
}

async function loadServer(origin: string): Promise<ServerState> {
  const fetchServer = (u: string, init: RequestInit): Promise<Response> => fetch(u, init);
  const [permitted, probe, tokens] = await Promise.all([
    browser.permissions.contains({ origins: [hostPermissionPattern(origin)] }).catch(() => false),
    loadRooms({ baseUrl: origin, fetch: fetchServer }),
    // One-shot, read-only injection into open room tabs, like the embed scan (ADR 0005, 0015).
    readShareTokens(origin, {
      queryTabs: (patterns) => browser.tabs.query({ url: patterns }),
      readSession: (tabId) =>
        browser.scripting
          .executeScript({ target: { tabId }, func: readRecordInPage, args: [SHARE_TOKEN_STORAGE_KEY, MAX_RECORD_LENGTH] })
          .then((results) => results[0]?.result),
    }),
  ]);
  return { origin, permitted, probe, tokens };
}

const serverBaseUrl = browser.storage.local.get(SERVER_BASE_URL_KEY).then((items) => readServerBaseUrl(items[SERVER_BASE_URL_KEY]));

renderRooms(FALLBACK_ROOMS);
renderServer();
void scan().then(render);
// One `GET /rooms` per popup open, in parallel with the scan so the embed list isn't held up.
void serverBaseUrl.then(loadServer).then((state) => {
  server = state;
  renderRooms(roomsWithTokens(state.probe.kind === "ok" ? state.probe.list : FALLBACK_ROOMS, state.tokens));
  renderServer();
});

ui.room.addEventListener("change", renderServer);

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const selected = ui.embeds.querySelector<HTMLInputElement>("input[name=embed]:checked");
  if (selected === null || server === null) return;
  const { origin, tokens } = server;
  const roomId = ui.room.value;
  ui.share.disabled = true;
  ui.status.hidden = true;
  void shareEmbed({ baseUrl: origin, roomId, url: selected.value, token: tokens.get(roomId) ?? null, fetch: (u, init) => fetch(u, init) })
    .then((result) => {
      if (result.ok) showStatus("ok", `Shared to ${roomId}.`);
      else showStatus("error", result.message);
    })
    .finally(renderServer);
});

ui.options.addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
});
