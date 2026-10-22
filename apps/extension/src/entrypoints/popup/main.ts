import type { Embed, Provider } from "@omega/shared";
import { browser } from "wxt/browser";
import { type ListedEmbed, type ScanOutcome, scanTab } from "../../embeds";
import { FALLBACK_ROOMS, LAST_ROOM_KEY, NEW_ROOM, type RoomList, type RoomsProbe, loadRooms, newRoomUrl, roomUrl, withLastRoom, withNewRoom, withRoomTabs } from "../../rooms";
import { collectCandidateUrls } from "../../scan";
import { serverStatus } from "../../server-status";
import { SERVER_BASE_URL_KEY, hostPermissionPattern, isLoopbackOrigin, ownHostsOf, readServerBaseUrl } from "../../settings";
import { addToQueue } from "../../queue";
import { shareEmbed } from "../../share";
import { type RoomTabs, readRoomTabs, roomTabPatterns } from "../../share-token";

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
  shareLabel: byId("share-label", HTMLSpanElement),
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

// A failed query reads as no tab, so the scan ends on "unreadable" instead of spinning (OME-1285).
const tab = targetTab().catch(() => undefined);

async function scan(): Promise<ScanOutcome> {
  const tabId = (await tab)?.id;
  if (tabId === undefined) return { kind: "unreadable" };
  // Our own site is never a generic embed. The storage read started at popup load, so this is ~free.
  const ownHosts = await serverBaseUrl.then(ownHostsOf, () => []);
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
  focusShare();
}

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

/** `null`: the tab could not be read, so neither the list nor "no video found" applies. */
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
  // Keyboard and screen reader users land on the list (OME-1286); the first row is the checked one.
  ui.embeds.querySelector("input")?.focus();
}

function renderRooms({ rooms, selected }: RoomList): void {
  ui.room.replaceChildren(...rooms.map((r) => new Option(r.label, r.id, r.id === selected, r.id === selected)));
}

/** Success is the room's system line with a check, an error is rust text with the warn icon (never colour alone). */
function showStatus(state: "ok" | "error", message: string | HTMLSpanElement): void {
  ui.status.dataset["state"] = state;
  ui.status.className = state === "ok" ? "ui-sysline" : "pk-error";
  ui.status.replaceChildren(sprite(state === "ok" ? "glyph-check" : "icon-warn"), typeof message === "string" ? span("", message) : message);
}

/** "Shared · Open room" (OME-1635): the button lands the user in the room. */
function sharedLine(prefix: string, origin: string, roomId: string): HTMLSpanElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pk-link";
  button.textContent = "Open room";
  button.addEventListener("click", () => {
    void openRoom(origin, roomId).then(() => {
      window.close();
    });
  });
  const line = span("", `${prefix} · `);
  line.append(button);
  return line;
}

/** Focuses the tab already showing the room (the server origin is a host permission, so `tabs.query` sees it), else opens one. */
async function openRoom(origin: string, roomId: string): Promise<void> {
  const url = roomUrl(origin, roomId);
  const path = new URL(url).pathname;
  // Like readRoomTabs: a loopback server's site may run on another local port.
  const loopback = isLoopbackOrigin(origin);
  const tabs = await browser.tabs.query({ url: roomTabPatterns(origin) }).catch(() => []);
  const open = tabs.find((t) => t.url !== undefined && URL.canParse(t.url) && new URL(t.url).pathname.replace(/\/$/, "") === path && (loopback || new URL(t.url).origin === origin));
  if (open?.id === undefined) {
    await browser.tabs.create({ url });
    return;
  }
  await browser.tabs.update(open.id, { active: true });
  await browser.windows.update(open.windowId, { focused: true });
}

/**
 * One embed and the remembered room, both preselected: Share takes focus, so Enter or one click shares (OME-1635).
 * Runs when the scan or the server load lands, whichever is last; never takes focus the user moved elsewhere.
 */
function focusShare(): void {
  const active = document.activeElement;
  const untouched = active === null || active === document.body || ui.embeds.contains(active);
  if (untouched && ui.embeds.childElementCount === 1 && lastRoom !== undefined && ui.room.value === lastRoom && !ui.share.disabled) ui.share.focus();
}

interface ServerState {
  readonly origin: string;
  readonly permitted: boolean;
  readonly probe: RoomsProbe;
  readonly tabs: RoomTabs;
}

/**
 * Share and Add to queue stay off until the server state is known, then follows the §5.4 table for the selected room.
 * "New room…" only opens the site (OME-1086), so it needs no token and works with the server away; its status line stays.
 */
let server: ServerState | null = null;

function renderServer(): void {
  const newRoom = ui.room.value === NEW_ROOM;
  const status = server === null ? null : serverStatus({ ...server, hasToken: newRoom || server.tabs.tokens.has(ui.room.value) });
  ui.share.disabled = server === null || (!newRoom && status?.canShare !== true);
  ui.shareLabel.textContent = newRoom ? "Create room & share" : "Share";
  ui.queue.hidden = newRoom;
  ui.queue.disabled = ui.share.disabled;
  // A live region, so it stays in the DOM: empty (CSS `:empty`) when there is nothing to say, never `hidden` (OME-1286).
  ui.serverMessage.textContent = status?.message ?? "";
  ui.serverAway.hidden = status?.away !== true;
  // Only on a change between quiet and saying something, so an unchanged line isn't re-inserted (and re-announced).
  const say = ui.serverMessage.textContent !== "";
  if (say !== ui.server.hasChildNodes()) {
    if (say) ui.server.append(ui.serverAway, ui.serverMessage);
    else ui.server.replaceChildren();
  }
  ui.options.dataset["emphasis"] = String(status?.openOptions === true);
}

const fetchServer = (u: string, init: RequestInit): Promise<Response> => fetch(u, init);

async function loadServer(origin: string): Promise<ServerState> {
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

const stored = browser.storage.local.get([SERVER_BASE_URL_KEY, LAST_ROOM_KEY]);
const serverBaseUrl = stored.then((items) => readServerBaseUrl(items[SERVER_BASE_URL_KEY]));
/** The room shared into last, once storage answers. */
let lastRoom: unknown;

renderRooms(FALLBACK_ROOMS);
renderServer();
void scan().then(render);
// One `GET /rooms` per popup open, in parallel with the scan so the embed list isn't held up.
void Promise.all([serverBaseUrl.then(loadServer), stored]).then(([state, items]) => {
  server = state;
  lastRoom = items[LAST_ROOM_KEY];
  const list = withLastRoom(withRoomTabs(state.probe.kind === "ok" ? state.probe.list : FALLBACK_ROOMS, state.tabs), items[LAST_ROOM_KEY], state.tabs.tokens);
  renderRooms(withNewRoom(list, state.probe, state.tabs.tokens));
  renderServer();
  focusShare();
}, () => {
  // Storage or the server load threw: Share stays off on the fallback rooms, but say why (OME-1101).
  showStatus("error", "Couldn't load the server settings. Close and reopen the popup.");
});

ui.room.addEventListener("change", renderServer);
// A new room or embed makes the last share's line stale; the load error (no server state) still explains why Share is off.
ui.form.addEventListener("change", () => {
  if (server !== null) ui.status.replaceChildren();
});

/** A share in flight. The keys go aria-disabled, not disabled, so the focused one keeps focus (OME-1286). */
let busy = false;

function setBusy(on: boolean): void {
  busy = on;
  for (const key of [ui.share, ui.queue]) {
    key.classList.toggle("is-disabled", on);
    if (on) key.setAttribute("aria-disabled", "true");
    else key.removeAttribute("aria-disabled");
  }
}

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  const selected = ui.embeds.querySelector<HTMLInputElement>("input[name=embed]:checked");
  if (selected === null || server === null) return;
  const { origin, tabs } = server;
  const roomId = ui.room.value;
  if (roomId === NEW_ROOM) {
    // The site creates the room and queues the video (ADR 0049); the URL is a candidate the scan already validated.
    void browser.tabs.create({ url: newRoomUrl(origin, selected.value) }).then(() => {
      window.close();
    });
    return;
  }
  const options = { baseUrl: origin, roomId, url: selected.value, token: tabs.tokens.get(roomId) ?? null, fetch: fetchServer };
  // Enter in the form shares; only the "Add to queue" button queues (ADR 0031).
  const queue = event.submitter === ui.queue;
  setBusy(true);
  ui.status.replaceChildren();
  void (queue ? addToQueue(options) : shareEmbed(options))
    .then((result) => {
      if (!result.ok) {
        showStatus("error", result.message);
        return;
      }
      showStatus("ok", sharedLine(queue ? "Added to the queue" : "Shared", origin, roomId));
      void browser.storage.local.set({ [LAST_ROOM_KEY]: roomId }).catch(() => undefined);
    })
    .finally(() => {
      setBusy(false);
      renderServer();
    });
});

// Close the popup once the options page is open: Firefox for Android opens it in a tab behind the popup's full-screen
// sheet, which would stay on top (OME-743). On desktop the popup is already closing as the tab takes focus.
ui.options.addEventListener("click", () => {
  void browser.runtime.openOptionsPage().then(() => {
    window.close();
  });
});
