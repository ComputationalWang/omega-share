import * as v from "valibot";
import { browser } from "wxt/browser";
import { BRIDGE_SOURCE, GenericHostSchema } from "@omega/shared/extension-bridge";
import { UNLOCK_HOSTS_KEY, unlockPermissions, withApproved } from "../../unlock";

// ADR 0047 §5: permissions.request needs a user gesture in an extension context, so the background opens this page.
// The background re-checks the grant and the room tab itself; this page only reports that the viewer answered.
const params = new URLSearchParams(location.search);
const host = v.safeParse(GenericHostSchema, params.get("host"));
const tabId = Number(params.get("tabId"));

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`consent: #${id} missing`);
  return el;
}

async function answer(): Promise<void> {
  if (!host.success) return;
  await browser.runtime.sendMessage({ source: BRIDGE_SOURCE, kind: "consent", tabId, host: host.output });
  window.close();
}

if (host.success && Number.isSafeInteger(tabId)) {
  const name = host.output;
  byId("title").textContent = `Let ${name} play in your omega-share room?`;
  byId("host-inline").textContent = name;
  byId("allow").addEventListener("click", () => {
    void browser.permissions
      .request(unlockPermissions(name, import.meta.env.BROWSER === "firefox" ? "firefox" : "chrome"))
      .catch(() => false)
      // The grant can't tell this host's consent from the found indicator's https://*/* (OME-1042), so record it.
      .then(async (granted) => {
        if (granted) await browser.storage.local.set({ [UNLOCK_HOSTS_KEY]: withApproved((await browser.storage.local.get(UNLOCK_HOSTS_KEY))[UNLOCK_HOSTS_KEY], name) });
      })
      .then(answer);
  });
  byId("deny").addEventListener("click", () => void answer());
} else {
  byId("title").textContent = "Nothing to unlock here.";
  for (const id of ["allow", "deny"]) byId(id).hidden = true;
}
