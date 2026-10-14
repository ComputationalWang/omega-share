import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { BRIDGE_SOURCE } from "@omega/shared/extension-bridge";
import { fromBackground, fromPage } from "../bridge";

// ADR 0047 §5: the site ↔ extension bridge. Registered at runtime by the background on our origin only (no manifest
// entry, no new host): it announces itself once, forwards parsed page messages and passes parsed replies back.
export default defineContentScript({
  registration: "runtime",
  noScriptStartedPostMessage: true,
  main() {
    const origin = location.origin;
    window.addEventListener("message", (event) => {
      const message = fromPage(event, window, origin);
      if (message !== null) void browser.runtime.sendMessage(message);
    });
    browser.runtime.onMessage.addListener((raw) => {
      const message = fromBackground(raw);
      if (message !== null) window.postMessage(message, origin);
    });
    window.postMessage({ source: BRIDGE_SOURCE, kind: "present", version: browser.runtime.getManifest().version }, origin);
  },
});
