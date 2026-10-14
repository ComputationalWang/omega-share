import type { Embed, Provider } from "@omega/shared";
import { browser } from "wxt/browser";
import { type ListedEmbed, type ScanOutcome, scanTab } from "../../embeds";
import { FALLBACK_ROOMS, type RoomList, type RoomsProbe, loadRooms, withRoomTabs } from "../../rooms";
import { collectCandidateUrls } from "../../scan";
import { serverStatus } from "../../server-status";
import { SERVER_BASE_URL_KEY, hostPermissionPattern, ownHostsOf, readServerBaseUrl } from "../../settings";
import { addToQueue } from "../../queue";
import { shareEmbed } from "../../share";
import { type RoomTabs, readRoomTabs } from "../../share-token";

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`popup: #${id} missing`);
  return el;
}

const ui = {
  host: byId("host", HTMLSpanElement),
  scanning: byId("scanning", HTMLParagraphElement),
  embeds: byId("embeds", HTMLUListElement),
  empty: byId("empty", HTMLParagraphElement),
  unreadable: byId("unreadable", HTMLParagraphElement),
  form: byId("share-form", HTMLFormElement),
  room: byId("room", HTMLSelectElement),
  share: byId("share", HTMLButtonElement),
  queue: byId("queue", HTMLButtonElement),
  status: byId("status", HTMLParagraphElement),
  server: byId("server-status", HTMLParagraphElement),
  serverMessage: byId("server-message", HTMLSpanElement),
  serverAway: byId("server-away", HTMLImageElement),
  options: byId("options", HTMLButtonElement),
};

/** `?tabId=` (used when the popup is opened as a tab, e.g. by e2e), else the active tab with its URL (activeTab grants it). */
async function targetTab(): Promise<{ readonly id?: number | undefined; readonly url?: string | undefined } | undefined> {
  const param = new URLSearchParams(location.search).get("tabId");
  if (param !== null && /^\d{1,10}$/.test(param)) return { id: Number(param) };
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** The page's host for the head, or "" when the tab has no readable http(s) URL. */
function hostOf(url: string | undefined): string {
  if (url === undefined || !URL.canParse(url)) return "";
  const { protocol, host } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? host : "";
}

const tab = targetTab();

async function scan(): Promise<ScanOutcome> {
  const tabId = (await tab)?.id;
  if (tabId === undefined) return { kind: "unreadable" };
  // Our own site is never a generic embed. The storage read started at popup load, so this is ~free.
  const ownHosts = ownHostsOf(await serverBaseUrl);
  return scanTab(() => browser.scripting.executeScript({ target: { tabId }, func: collectCandidateUrls, injectImmediately: true }), ownHosts);
}

function render(outcome: ScanOutcome): void {
  ui.scanning.hidden = true;
  if (outcome.kind === "embeds") {
    void tab.then((t) => {
      ui.host.textContent = hostOf(t?.url);
    });
  }
  ui.unreadable.hidden = outcome.kind !== "unreadable";
  renderEmbeds(outcome.kind === "embeds" ? outcome.embeds : null);
}

/** `null`: the tab could not be read, so neither the list nor "no video found" applies. */
const PROVIDER_NAMES: Readonly<Record<Provider, string>> = { youtube: "YouTube", twitch: "Twitch", vimeo: "Vimeo" };

/** What the user sees for an embed: the video id, or the channel for Twitch live. */
function embedId(embed: Embed): string {
  return embed.provider === "twitch" && embed.kind === "live" ? embed.channel : embed.videoId;
}

function span(className: string, text = ""): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function sprite(key: string): HTMLSpanElement {
  const el = span(`pk-sprite pk-${key}`);
  el.setAttribute("aria-hidden", "true");
  return el;
}

/**
 * One kit row (OME-1041): radio glyph, source tile, the name over its id, and the ADR 0024 chip. Synced: provider and id.
 * Generic: the host over "Page embed" and its frame size, "Not synced" (OME-1037). Spaces between the parts keep the text readable.
 */
function embedRow(embed: ListedEmbed): (HTMLSpanElement | string)[] {
  const generic = embed.provider === "generic";
  const title = generic ? embed.host : PROVIDER_NAMES[embed.provider];
  const size = generic && embed.size !== undefined ? ` · ${String(embed.size.width)}×${String(embed.size.height)}` : "";
  const meta = generic ? `Page embed${size}` : embedId(embed);
  const source = generic ? "qsrc-generic" : embed.provider === "twitch" && embed.kind === "live" ? "qsrc-live" : "qsrc-video";
  const body = span("body");
  body.append(span("title", title), " ", span("meta", meta));
  const chip = span(generic ? "ui-chip solo" : "ui-chip");
  chip.append(sprite(generic ? "glyph-outsync" : "glyph-insync"), generic ? "Not synced" : "Synced");
  return [sprite("glyph-radio-off"), sprite(source), body, " ", chip];
}

function renderEmbeds(embeds: readonly ListedEmbed[] | null): void {
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
      label.className = "ui-qrow pk-embed";
      label.append(input, ...embedRow(embed));
      const li = document.createElement("li");
      li.dataset["testid"] = "embed-item";
      li.dataset["provider"] = embed.provider;
      if (embed.provider === "generic") li.dataset["host"] = embed.host;
      else li.dataset["videoId"] = embedId(embed);
      li.append(label);
      return li;
    }),
  );
}

function renderRooms({ rooms, selected }: RoomList): void {
  ui.room.replaceChildren(...rooms.map((r) => new Option(r.label, r.id, r.id === selected, r.id === selected)));
}

/** Success is the room's system line with a check, an error is rust text with the warn icon (never colour alone). */
function showStatus(state: "ok" | "error", message: string): void {
  ui.status.hidden = false;
  ui.status.dataset["state"] = state;
  ui.status.className = state === "ok" ? "ui-sysline" : "pk-error";
  ui.status.replaceChildren(sprite(state === "ok" ? "glyph-check" : "icon-warn"), span("", message));
}

interface ServerState {
  readonly origin: string;
  readonly permitted: boolean;
  readonly probe: RoomsProbe;
  readonly tabs: RoomTabs;
}

/** Share and Add to queue stay off until the server state is known, then follows the §5.4 table for the selected room. */
let server: ServerState | null = null;

function renderServer(): void {
  const status = server === null ? null : serverStatus({ ...server, hasToken: server.tabs.tokens.has(ui.room.value) });
  ui.share.disabled = status?.canShare !== true;
  ui.queue.disabled = ui.share.disabled;
  ui.server.hidden = status?.message === null || status === null;
  ui.serverMessage.textContent = status?.message ?? "";
  ui.serverAway.hidden = status?.away !== true;
  ui.options.dataset["emphasis"] = String(status?.openOptions === true);
}

async function loadServer(origin: string): Promise<ServerState> {
  const fetchServer = (u: string, init: RequestInit): Promise<Response> => fetch(u, init);
  const [permitted, probe, tabs] = await Promise.all([
    browser.permissions.contains({ origins: [hostPermissionPattern(origin)] }).catch(() => false),
    loadRooms({ baseUrl: origin, fetch: fetchServer }),
    // One-shot, read-only injection into open room tabs, like the embed scan (ADR 0005, 0015).
    readRoomTabs(origin, {
      queryTabs: (patterns) => browser.tabs.query({ url: patterns }),
      inject: (tabId, func, args) => browser.scripting.executeScript({ target: { tabId }, func, args }).then((results) => results[0]?.result),
    }),
  ]);
  return { origin, permitted, probe, tabs };
}

const serverBaseUrl = browser.storage.local.get(SERVER_BASE_URL_KEY).then((items) => readServerBaseUrl(items[SERVER_BASE_URL_KEY]));

renderRooms(FALLBACK_ROOMS);
renderServer();
void scan().then(render);
// One `GET /rooms` per popup open, in parallel with the scan so the embed list isn't held up.
void serverBaseUrl.then(loadServer).then((state) => {
  server = state;
  renderRooms(withRoomTabs(state.probe.kind === "ok" ? state.probe.list : FALLBACK_ROOMS, state.tabs));
  renderServer();
});

ui.room.addEventListener("change", renderServer);

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const selected = ui.embeds.querySelector<HTMLInputElement>("input[name=embed]:checked");
  if (selected === null || server === null) return;
  const { origin, tabs } = server;
  const roomId = ui.room.value;
  const options = { baseUrl: origin, roomId, url: selected.value, token: tabs.tokens.get(roomId) ?? null, fetch: (u: string, init: RequestInit) => fetch(u, init) };
  // Enter in the form shares; only the "Add to queue" button queues (ADR 0031).
  const queue = event.submitter === ui.queue;
  ui.share.disabled = true;
  ui.queue.disabled = true;
  ui.status.hidden = true;
  void (queue ? addToQueue(options) : shareEmbed(options))
    .then((result) => {
      if (result.ok) showStatus("ok", queue ? `Added to the queue in ${roomId}.` : `Shared to ${roomId}.`);
      else showStatus("error", result.message);
    })
    .finally(renderServer);
});

// Close the popup once the options page is open: Firefox for Android opens it in a tab behind the popup's full-screen
// sheet, which would stay on top (OME-743). On desktop the popup is already closing as the tab takes focus.
ui.options.addEventListener("click", () => {
  void browser.runtime.openOptionsPage().then(() => {
    window.close();
  });
});
